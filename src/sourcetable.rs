//! Sourcetable for the virtual mountpoint and configured direct sources.
use crate::config::Config;

pub fn sourcetable(config: &Config) -> String {
    let auth = if config.requires_auth() { "B" } else { "N" };
    let (lat, lon) = centroid(config);
    let mut row = format!(
        "STR;{mount};NearTRIP;RTCM 3;;2;GPS+GLO+GAL+BDS;NearTRIP;none;{lat:.4};{lon:.4};1;0;none;none;{auth};N;0;",
        mount = config.mount_point,
    );
    for source in config.sources.iter().filter(|s| s.active) {
        row.push_str(&format!(
            "\r\nSTR;{mount};NearTRIP Direct;RTCM 3;;2;GPS+GLO+GAL+BDS;NearTRIP;none;{lat:.4};{lon:.4};0;0;none;none;{auth};N;0;",
            mount = source.mount_point, lat = source.latitude.unwrap_or(0.0),
            lon = source.longitude.unwrap_or(0.0),
        ));
    }
    format!("SOURCETABLE 200 OK\r\nContent-Type: text/plain\r\n\r\n{row}\r\nENDSOURCETABLE\r\n")
}

fn centroid(config: &Config) -> (f64, f64) {
    let positions: Vec<_> = config
        .stations
        .iter()
        .filter(|s| s.active)
        .map(|s| (s.latitude, s.longitude))
        .chain(
            config
                .sources
                .iter()
                .filter(|s| s.active)
                .filter_map(|s| Some((s.latitude?, s.longitude?))),
        )
        .collect();
    if positions.is_empty() {
        return (0.0, 0.0);
    }
    let count = positions.len() as f64;
    (
        positions.iter().map(|s| s.0).sum::<f64>() / count,
        positions.iter().map(|s| s.1).sum::<f64>() / count,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn advertises_active_direct_sources_without_requiring_gga_on_fixed_mounts() {
        let config = Config::parse(
            r#"{"mountPoint":"NEAR","username":"rover","password":"p","sources":[
            {"mountPoint":"BASE","username":"b","password":"s","latitude":37,"longitude":-122},
            {"mountPoint":"OFF","username":"b","password":"s","active":false}
        ]}"#,
        )
        .unwrap();
        let table = sourcetable(&config);
        assert!(table.contains("STR;NEAR;"));
        assert!(table.contains("STR;BASE;"));
        assert!(!table.contains("STR;OFF;"));
        assert!(table.contains(";37.0000;-122.0000;0;0;none;none;B;"));
        assert_eq!(centroid(&config), (37.0, -122.0));
    }
}
