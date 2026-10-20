//! Network admission based on reported position stability, not surveyed accuracy.
use crate::{config::Source, geo::distance_m, rtcm::Position};
use tokio::time::Instant;

#[derive(Clone)]
struct Anchor {
    latitude: f64,
    longitude: f64,
    height: Option<f64>,
    station_id: Option<u16>,
}

#[derive(Default)]
pub struct Qualification {
    anchor: Option<Anchor>,
    since: Option<Instant>,
    last_position: Option<Instant>,
    moved: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Onboarding {
    pub status: &'static str,
    pub reason: Option<&'static str>,
    pub settling_seconds: u64,
    pub position_tolerance_m: f64,
    pub elapsed_seconds: u64,
    pub remaining_seconds: u64,
}

impl Qualification {
    pub fn observe(
        &mut self,
        source: &Source,
        position: Option<&Position>,
        updated: bool,
        interrupted: bool,
    ) {
        let observed_at = Instant::now();
        let next = position
            .map(|p| Anchor {
                latitude: p.latitude,
                longitude: p.longitude,
                height: Some(p.ellipsoidal_height_m),
                station_id: Some(p.station_id),
            })
            .or_else(|| {
                Some(Anchor {
                    latitude: source.latitude?,
                    longitude: source.longitude?,
                    height: None,
                    station_id: None,
                })
            });
        let Some(next) = next else {
            return;
        };
        let moved = self.anchor.as_ref().is_some_and(|anchor| {
            let horizontal = distance_m(
                anchor.latitude,
                anchor.longitude,
                next.latitude,
                next.longitude,
            );
            let vertical = match (anchor.height, next.height) {
                (Some(a), Some(b)) => a - b,
                _ => 0.0,
            };
            horizontal.hypot(vertical) > source.position_tolerance_m
                || anchor.station_id != next.station_id
        });
        if self.anchor.is_none() || interrupted || moved {
            self.anchor = Some(next);
            self.since = Some(observed_at);
            self.last_position = None;
            self.moved = moved;
        }
        if updated {
            self.last_position = Some(observed_at);
        }
    }

    pub fn view(
        &self,
        source: &Source,
        connected: bool,
        has_data: bool,
        healthy: bool,
    ) -> Onboarding {
        let mut view = Onboarding {
            status: "detecting",
            reason: None,
            settling_seconds: source.settling_seconds,
            position_tolerance_m: source.position_tolerance_m,
            elapsed_seconds: 0,
            remaining_seconds: source.settling_seconds,
        };
        if !source.active || !connected || (has_data && !healthy) {
            view.status = "needs_attention";
            view.reason = Some(if !source.active {
                "Publisher disabled"
            } else if !connected {
                "Publisher offline"
            } else {
                "Correction data is stale; qualification will restart"
            });
            return view;
        }
        if !has_data {
            view.reason = Some("Waiting for correction data");
            return view;
        }
        let Some(since) = self.since else {
            view.reason = Some("Waiting for RTCM 1005/1006 or manual fallback coordinates");
            return view;
        };
        let elapsed = since.elapsed().as_secs();
        view.elapsed_seconds = elapsed.min(source.settling_seconds);
        view.remaining_seconds = source.settling_seconds.saturating_sub(elapsed);
        // Automatic positions must be observed again after the full window.
        // Manual fallback positions are supplied by the administrator.
        let confirmed = self.anchor.as_ref().is_some_and(|a| a.station_id.is_none())
            || source.settling_seconds == 0
            || self.last_position.is_some_and(|last| {
                last.duration_since(since).as_secs() >= source.settling_seconds
            });
        if elapsed >= source.settling_seconds && confirmed {
            view.status = "ready";
        } else if elapsed >= source.settling_seconds {
            view.status = "needs_attention";
            view.reason =
                Some("Waiting for a confirming RTCM position report after the settling period");
        } else if self.moved && self.last_position.is_none_or(|last| last <= since) {
            view.status = "needs_attention";
            view.reason =
                Some("Reported position or station identity changed; qualification restarted");
        } else {
            view.status = "settling";
            view.reason = Some("Checking reported position stability");
        }
        view
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn source() -> Source {
        crate::Config::parse(r#"{"sources":[{"mountPoint":"A","username":"a","password":"p","settlingSeconds":60,"positionToleranceM":5}]}"#).unwrap().sources.remove(0)
    }
    fn position() -> Position {
        Position {
            latitude: 37.0,
            longitude: -122.0,
            ellipsoidal_height_m: 10.0,
            antenna_height_m: None,
            station_id: 1,
            message_type: 1005,
        }
    }
    #[tokio::test]
    async fn movement_report_keeps_attention_reason_with_a_live_clock() {
        let source = source();
        let mut q = Qualification::default();
        let mut p = position();
        q.observe(&source, Some(&p), true, false);
        p.longitude += 0.001;
        q.observe(&source, Some(&p), true, false);
        assert_eq!(
            q.since, q.last_position,
            "one observation must use a single timestamp"
        );
        let view = q.view(&source, true, true, true);
        assert_eq!(view.status, "needs_attention");
        assert!(view.reason.unwrap().contains("changed"));
        tokio::time::sleep(Duration::from_millis(1)).await;
        q.observe(&source, Some(&p), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "settling");
    }

    #[tokio::test(start_paused = true)]
    async fn detects_settles_waits_for_confirmation_then_qualifies() {
        let source = source();
        let mut q = Qualification::default();
        assert_eq!(q.view(&source, true, false, false).status, "detecting");
        assert_eq!(q.view(&source, true, true, true).status, "detecting");
        q.observe(&source, Some(&position()), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "settling");
        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(q.view(&source, true, true, true).status, "needs_attention");
        q.observe(&source, Some(&position()), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "ready");
        assert_eq!(q.view(&source, true, true, false).status, "needs_attention");
        q.observe(&source, Some(&position()), true, true);
        assert_eq!(q.view(&source, true, true, true).remaining_seconds, 60);
    }
    #[tokio::test(start_paused = true)]
    async fn anchored_movement_including_height_and_identity_restarts_the_window() {
        let source = source();
        let mut q = Qualification::default();
        let mut p = position();
        q.observe(&source, Some(&p), true, false);
        tokio::time::advance(Duration::from_secs(60)).await;
        q.observe(&source, Some(&p), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "ready");
        // Slow drift is measured from the original anchor, not the previous report.
        p.ellipsoidal_height_m += 3.0;
        q.observe(&source, Some(&p), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "ready");
        p.ellipsoidal_height_m += 3.0;
        q.observe(&source, Some(&p), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "needs_attention");
        assert_eq!(q.view(&source, true, true, true).remaining_seconds, 60);
        tokio::time::advance(Duration::from_secs(1)).await;
        q.observe(&source, Some(&p), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "settling");
        tokio::time::advance(Duration::from_secs(60)).await;
        q.observe(&source, Some(&p), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "ready");
        p.station_id = 2;
        q.observe(&source, Some(&p), true, false);
        assert_eq!(q.view(&source, true, true, true).remaining_seconds, 60);
        p.longitude += 0.001;
        q.observe(&source, Some(&p), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "needs_attention");
    }
    #[tokio::test(start_paused = true)]
    async fn manual_fallback_and_zero_period_still_require_data_and_position() {
        let mut source = source();
        source.latitude = Some(0.0);
        source.longitude = Some(0.0);
        let mut q = Qualification::default();
        q.observe(&source, None, false, false);
        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(q.view(&source, true, true, true).status, "ready");
        assert_eq!(q.view(&source, false, true, true).status, "needs_attention");
        source.active = false;
        assert_eq!(q.view(&source, true, true, true).status, "needs_attention");
        source.active = true;
        source.settling_seconds = 0;
        assert_eq!(
            Qualification::default()
                .view(&source, true, true, true)
                .status,
            "detecting"
        );
        q.observe(&source, Some(&position()), true, false);
        assert_eq!(q.view(&source, true, true, true).status, "ready");
    }
}
