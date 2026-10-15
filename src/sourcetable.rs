//! Sourcetable for the single virtual mountpoint.
use crate::config::Config;

pub fn sourcetable(config: &Config) -> String {
    let auth = if config.requires_auth() { "B" } else { "N" };
    let (lat, lon) = centroid(config);
    let row = format!(
        "STR;{mount};NearTRIP;RTCM 3;;2;GPS+GLO+GAL+BDS;NearTRIP;none;{lat:.4};{lon:.4};1;0;none;none;{auth};N;0;",
        mount = config.mount_point,
    );
    format!(
        "SOURCETABLE 200 OK\r\nContent-Type: text/plain\r\n\r\n{row}\r\nENDSOURCETABLE\r\n"
    )
}

fn centroid(config: &Config) -> (f64, f64) {
    let active: Vec<_> = config.stations.iter().filter(|s| s.active).collect();
    if active.is_empty() {
        return (0.0, 0.0);
    }
    let lat = active.iter().map(|s| s.latitude).sum::<f64>() / active.len() as f64;
    let lon = active.iter().map(|s| s.longitude).sum::<f64>() / active.len() as f64;
    (lat, lon)
}
