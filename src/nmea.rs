//! GGA sentence parsing. Talker id may be GP, GN, GA, GL, GB, or GQ.
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gga {
    pub latitude: f64,
    pub longitude: f64,
    pub fix_quality: u32,
    pub num_satellites: u32,
    /// Original sentence without the line ending, checksum included.
    pub sentence: String,
}

/// Parse one NMEA line. `None` when it is not a valid GGA sentence.
pub fn parse_gga(line: &str) -> Option<Gga> {
    let line = line.trim().trim_end_matches('\0');
    if line.is_empty() || line.len() > 1024 || !line.is_ascii() {
        return None;
    }
    let (body, given) = line.split_once('*')?;
    if given.len() != 2 || !given.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut checksum = 0u8;
    for byte in body.as_bytes().iter().skip(1) {
        checksum ^= byte;
    }
    if !given.eq_ignore_ascii_case(&format!("{checksum:02X}")) {
        return None;
    }
    let fields: Vec<&str> = body.split(',').collect();
    if fields.len() < 15 {
        return None;
    }
    let kind = fields[0];
    if kind.len() != 6 || !kind.starts_with('$') || !kind.ends_with("GGA") {
        return None;
    }
    if fields[2].is_empty() || fields[4].is_empty() {
        return None;
    }
    let lat = apply_hemisphere(parse_nmea_coord(fields[2])?, fields[3], 'N', 'S')?;
    let lon = apply_hemisphere(parse_nmea_coord(fields[4])?, fields[5], 'E', 'W')?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return None;
    }
    Some(Gga {
        latitude: lat,
        longitude: lon,
        fix_quality: fields[6].parse().unwrap_or(0),
        num_satellites: fields[7].parse().unwrap_or(0),
        sentence: line.to_string(),
    })
}

fn parse_nmea_coord(raw: &str) -> Option<f64> {
    let value: f64 = raw.parse().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    let degrees = (value / 100.0).floor();
    let minutes = value - degrees * 100.0;
    if minutes >= 60.0 {
        return None;
    }
    Some(degrees + minutes / 60.0)
}

fn apply_hemisphere(value: f64, hemi: &str, positive: char, negative: char) -> Option<f64> {
    let mark = hemi.chars().next()?.to_ascii_uppercase();
    if mark == positive {
        Some(value)
    } else if mark == negative {
        Some(-value)
    } else {
        None
    }
}

/// Append an NMEA checksum. `body` includes the leading `$`.
pub fn with_checksum(body: &str) -> String {
    let mut checksum = 0u8;
    for byte in body.as_bytes().iter().skip(1) {
        checksum ^= byte;
    }
    format!("{body}*{checksum:02X}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_checksums_and_oversized_sentences_never_panic() {
        for line in [
            "$GPGGA*aé",
            "$GPGGA*é",
            "$GPGGA*",
            "$GPGGA*0",
            "$GPGGA*ZZ",
            "$GPGGA*000",
        ] {
            assert_eq!(parse_gga(line), None, "{line}");
        }
        let huge = with_checksum(&format!("$GPGGA,{}", "1".repeat(2048)));
        assert!(parse_gga(&huge).is_none());
    }

    #[test]
    fn parses_the_sample_gpgga_sentence() {
        let sentence = "$GPGGA,123519,3723.2475,N,12158.3416,W,1,07,1.0,9.0,M,-34.2,M,,*74";
        let parsed = parse_gga(sentence).unwrap();
        assert!((parsed.latitude - 37.387458).abs() < 1e-5);
        assert!((parsed.longitude + 121.972360).abs() < 1e-5);
        assert_eq!(parsed.fix_quality, 1);
        assert_eq!(parsed.num_satellites, 7);
    }

    #[test]
    fn accepts_gngga_and_rejects_other_sentences() {
        let body = "$GNGGA,123519,3723.2475,N,12158.3416,W,1,07,1.0,9.0,M,-34.2,M,,";
        let sentence = with_checksum(body);
        assert!(parse_gga(&sentence).is_some());
        assert!(parse_gga("$GPGSA,A,3,,,,,,,,,,,,,1.0,1.0,1.0*33").is_none());
        assert!(
            parse_gga("$GPRMC,123519,A,3723.2475,N,12158.3416,W,0.1,309.62,120598,*10").is_none()
        );
    }

    #[test]
    fn rejects_a_bad_checksum_and_missing_coordinates() {
        assert!(
            parse_gga("$GPGGA,123519,3723.2475,N,12158.3416,W,1,07,1.0,9.0,M,-34.2,M,,*00")
                .is_none()
        );
        let missing = with_checksum("$GPGGA,123519,,N,,W,1,07,1.0,9.0,M,-34.2,M,,");
        assert!(parse_gga(&missing).is_none());
    }
}
