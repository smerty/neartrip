//! Station choice. The current caster stays until another is closer by [`SWITCH_MARGIN_M`].
use crate::config::Station;

/// Meters another station must save before an existing caster link is torn down.
pub const SWITCH_MARGIN_M: f64 = 500.0;

#[derive(Debug, Clone, Copy)]
pub struct Chosen<'a> {
    pub station: &'a Station,
    pub distance_m: f64,
}

pub fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_M: f64 = 6_371_000.0;
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let dlat = lat2 - lat1;
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_M * a.sqrt().atan2((1.0 - a).sqrt())
}

pub fn select_station<'a>(
    lat: f64,
    lon: f64,
    stations: &'a [Station],
    current_mount: Option<&str>,
    margin_m: f64,
) -> Option<Chosen<'a>> {
    if !lat.is_finite() || !lon.is_finite() {
        return None;
    }
    let mut best: Option<Chosen<'a>> = None;
    let mut current: Option<Chosen<'a>> = None;
    for station in stations {
        if !station.active || !station.latitude.is_finite() || !station.longitude.is_finite() {
            continue;
        }
        if station.caster_host.is_empty() || station.mount_point.is_empty() {
            continue;
        }
        let distance_m = distance_m(lat, lon, station.latitude, station.longitude);
        if !distance_m.is_finite() {
            continue;
        }
        if current_mount == Some(station.mount_point.as_str()) {
            current = Some(Chosen {
                station,
                distance_m,
            });
        }
        let closer = best.as_ref().map(|b| distance_m < b.distance_m).unwrap_or(true);
        if closer {
            best = Some(Chosen {
                station,
                distance_m,
            });
        }
    }
    match (current, best) {
        (Some(current), Some(best)) if current.station.mount_point != best.station.mount_point => {
            if current.distance_m - best.distance_m < margin_m {
                Some(current)
            } else {
                Some(best)
            }
        }
        (_, best) => best,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn station(mount: &str, lat: f64, lon: f64, active: bool) -> Station {
        Station {
            mount_point: mount.to_string(),
            caster_host: "127.0.0.1".to_string(),
            caster_port: 2101,
            username: String::new(),
            password: String::new(),
            latitude: lat,
            longitude: lon,
            active,
        }
    }

    #[test]
    fn stays_with_the_current_station_inside_the_margin() {
        let stations = vec![station("Near", 37.0, -122.0, true), station("Farther", 37.003, -122.0, true)];
        let chosen = select_station(37.0, -122.0, &stations, Some("Near"), SWITCH_MARGIN_M).unwrap();
        assert_eq!(chosen.station.mount_point, "Near");
    }

    #[test]
    fn switches_when_the_other_station_is_meaningfully_closer() {
        let stations = vec![station("Near", 37.0, -122.0, true), station("North", 38.0, -122.0, true)];
        let chosen = select_station(37.9, -122.0, &stations, Some("Near"), SWITCH_MARGIN_M).unwrap();
        assert_eq!(chosen.station.mount_point, "North");
    }

    #[test]
    fn skips_inactive_stations() {
        let stations = vec![station("Off", 37.0, -122.0, false), station("On", 38.0, -122.0, true)];
        let chosen = select_station(37.0, -122.0, &stations, None, SWITCH_MARGIN_M).unwrap();
        assert_eq!(chosen.station.mount_point, "On");
    }
}
