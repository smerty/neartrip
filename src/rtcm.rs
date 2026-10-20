//! Passive RTCM 3 position inspection. Original stream bytes are never rewritten.
//! Field layout: RTCM 1005/1006 stationary reference station antenna reference point.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub latitude: f64,
    pub longitude: f64,
    /// Antenna reference point height above the WGS84 ellipsoid, in meters.
    pub ellipsoidal_height_m: f64,
    /// Separate 1006 antenna-height field; do not add it to ARP height.
    pub antenna_height_m: Option<f64>,
    pub station_id: u16,
    pub message_type: u16,
}

#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
}

impl Decoder {
    /// Accept arbitrary TCP fragments, retaining at most one RTCM frame.
    pub fn feed(&mut self, bytes: &[u8]) -> Option<Position> {
        self.feed_positions(bytes).pop()
    }

    pub(crate) fn feed_positions(&mut self, bytes: &[u8]) -> Vec<Position> {
        let mut positions = Vec::new();
        for byte in bytes {
            self.buffer.push(*byte);
            loop {
                if self.buffer.first() != Some(&0xd3) {
                    self.resync();
                    if self.buffer.is_empty() {
                        break;
                    }
                    continue;
                }
                if self.buffer.len() < 3 {
                    break;
                }
                if self.buffer[1] & 0xfc != 0 {
                    self.resync();
                    continue;
                }
                let length = (((self.buffer[1] & 3) as usize) << 8) | self.buffer[2] as usize;
                let end = length + 3;
                if self.buffer.len() < end + 3 {
                    break;
                }
                let crc = ((self.buffer[end] as u32) << 16)
                    | ((self.buffer[end + 1] as u32) << 8)
                    | self.buffer[end + 2] as u32;
                if crc24q(&self.buffer[..end]) != crc {
                    self.resync();
                    continue;
                }
                if let Some(position) = decode_position(&self.buffer[3..end]) {
                    positions.push(position);
                }
                self.buffer.drain(..end + 3);
                if self.buffer.is_empty() {
                    break;
                }
            }
        }
        positions
    }

    fn resync(&mut self) {
        let next = self
            .buffer
            .iter()
            .skip(1)
            .position(|b| *b == 0xd3)
            .map_or(self.buffer.len(), |p| p + 1);
        self.buffer.drain(..next);
    }
}

pub fn crc24q(bytes: &[u8]) -> u32 {
    let mut crc = 0u32;
    for byte in bytes {
        crc ^= (*byte as u32) << 16;
        for _ in 0..8 {
            crc <<= 1;
            if crc & 0x1000000 != 0 {
                crc ^= 0x1864cfb;
            }
        }
    }
    crc & 0xffffff
}

fn bits(data: &[u8], start: usize, count: usize) -> u64 {
    (start..start + count).fold(0, |value, i| {
        (value << 1) | ((data[i / 8] >> (7 - i % 8)) & 1) as u64
    })
}
fn coordinate(data: &[u8], start: usize) -> f64 {
    let raw = bits(data, start, 38);
    // Sign extension of the two's-complement 38-bit ECEF coordinate.
    let signed = if raw & (1 << 37) != 0 {
        raw as i64 - (1i64 << 38)
    } else {
        raw as i64
    };
    signed as f64 * 0.0001
}
fn decode_position(payload: &[u8]) -> Option<Position> {
    if payload.len() < 2 {
        return None;
    }
    let message_type = bits(payload, 0, 12) as u16;
    match (message_type, payload.len()) {
        (1005, 19) | (1006, 21) => {}
        _ => return None,
    }
    let x = coordinate(payload, 34);
    let y = coordinate(payload, 74);
    let z = coordinate(payload, 114);
    let p = x.hypot(y);
    let radius = p.hypot(z);
    if !(6_000_000.0..=7_000_000.0).contains(&radius) {
        return None;
    }

    const A: f64 = 6_378_137.0;
    const E2: f64 = 6.6943799901413165e-3;
    let mut latitude = z.atan2(p * (1.0 - E2));
    for _ in 0..12 {
        let sin = latitude.sin();
        let n = A / (1.0 - E2 * sin * sin).sqrt();
        let next = (z + E2 * n * sin).atan2(p);
        if (next - latitude).abs() < 1e-14 {
            latitude = next;
            break;
        }
        latitude = next;
    }
    let sin = latitude.sin();
    let height = p * latitude.cos() + z * sin - A * (1.0 - E2 * sin * sin).sqrt();
    Some(Position {
        latitude: latitude.to_degrees(),
        longitude: y.atan2(x).to_degrees(),
        ellipsoidal_height_m: height,
        antenna_height_m: (message_type == 1006).then(|| bits(payload, 152, 16) as f64 * 0.0001),
        station_id: bits(payload, 12, 12) as u16,
        message_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn put(data: &mut [u8], start: usize, count: usize, value: i64) {
        for i in 0..count {
            if (value as u64 >> (count - 1 - i)) & 1 != 0 {
                data[(start + i) / 8] |= 1 << (7 - (start + i) % 8);
            }
        }
    }
    pub(crate) fn frame(kind: u16, xyz: [f64; 3], antenna: u16) -> Vec<u8> {
        let mut payload = vec![0; if kind == 1006 { 21 } else { 19 }];
        put(&mut payload, 0, 12, kind as i64);
        put(&mut payload, 12, 12, 42);
        for (start, value) in [34, 74, 114].into_iter().zip(xyz) {
            put(&mut payload, start, 38, (value * 10000.0).round() as i64);
        }
        if kind == 1006 {
            put(&mut payload, 152, 16, antenna as i64);
        }
        let mut frame = vec![0xd3, 0, payload.len() as u8];
        frame.extend(payload);
        let crc = crc24q(&frame);
        frame.extend_from_slice(&crc.to_be_bytes()[1..]);
        frame
    }
    #[test]
    fn crc_matches_check_vector() {
        assert_eq!(crc24q(b"123456789"), 0xcde703);
    }
    #[test]
    fn fragmented_equatorial_1005_and_southern_polar_1006() {
        let frame = frame(1005, [6_378_237.0, 0.0, 0.0], 0);
        let mut decoder = Decoder::default();
        for byte in &frame[..frame.len() - 1] {
            assert!(decoder.feed(&[*byte]).is_none());
        }
        let position = decoder.feed(&frame[frame.len() - 1..]).unwrap();
        assert_eq!(position.station_id, 42);
        assert_eq!(position.message_type, 1005);
        assert_eq!(position.latitude, 0.0);
        assert_eq!(position.longitude, 0.0);
        assert!((position.ellipsoidal_height_m - 100.0).abs() < 0.0001);
        assert!(position.antenna_height_m.is_none());
        let position = decoder
            .feed(&self::frame(1006, [0.0, 0.0, -6_356_752.3142], 12345))
            .unwrap();
        assert!((position.latitude + 90.0).abs() < 1e-9);
        assert!(position.ellipsoidal_height_m.abs() < 0.0001);
        assert!((position.antenna_height_m.unwrap() - 1.2345).abs() < 1e-10);
    }
    #[test]
    fn converts_midlatitude_ecef_in_both_hemispheres() {
        for (lat, lon, height) in [
            (37.0_f64, -122.0_f64, 1234.5),
            (-33.0, 151.0, -10.0),
            (89.999, 179.9, 5000.0),
        ] {
            let phi = lat.to_radians();
            let lambda = lon.to_radians();
            let e2 = 6.6943799901413165e-3;
            let n = 6_378_137.0 / (1.0 - e2 * phi.sin().powi(2)).sqrt();
            let xyz = [
                (n + height) * phi.cos() * lambda.cos(),
                (n + height) * phi.cos() * lambda.sin(),
                (n * (1.0 - e2) + height) * phi.sin(),
            ];
            let position = Decoder::default().feed(&frame(1005, xyz, 0)).unwrap();
            assert!((position.latitude - lat).abs() < 1e-8);
            assert!((position.longitude - lon).abs() < 0.0001);
            assert!((position.ellipsoidal_height_m - height).abs() < 0.001);
        }
    }

    #[test]
    fn oversized_corrupt_frame_preserves_both_position_reports_across_noise() {
        let first = frame(1005, [6_378_237.0, 0.0, 0.0], 0);
        let mut second = frame(1006, [6_378_247.0, 0.0, 0.0], 0);
        second[5] |= 1; // Change station ID from 42 to 43.
        let end = second.len() - 3;
        let checksum = crc24q(&second[..end]);
        second[end..].copy_from_slice(&checksum.to_be_bytes()[1..]);
        let mut corrupt = vec![0xd3, 3, 0xff]; // Bogus 1023-byte payload.
        corrupt.extend(&first);
        corrupt.extend([0x11, 0x22, 0x33]);
        corrupt.extend(&second);
        corrupt.resize(1029, 0);
        assert_ne!(crc24q(&corrupt[..1026]), 0);
        for chunk_size in [1, 7, 1029] {
            let mut decoder = Decoder::default();
            let reports: Vec<_> = corrupt
                .chunks(chunk_size)
                .flat_map(|chunk| decoder.feed_positions(chunk))
                .collect();
            assert_eq!(reports.len(), 2, "chunk size {chunk_size}");
            assert_eq!(reports[0].station_id, 42);
            assert_eq!(reports[1].station_id, 43);
            assert!((reports[1].ellipsoidal_height_m - 110.0).abs() < 0.001);
            assert!(decoder.buffer.is_empty());
        }
    }

    #[test]
    fn rejects_bad_crc_invalid_positions_and_recovers_from_noise() {
        let good = frame(1005, [0.0, -6_378_137.0, 0.0], 0);
        let mut bad = good.clone();
        bad[10] ^= 1;
        let mut decoder = Decoder::default();
        assert!(decoder.feed(&bad).is_none());
        assert!(decoder.feed(&frame(1005, [0.0; 3], 0)).is_none());
        let mut bytes = vec![0, 3, 0xd3, 0xfc, 0xff];
        bytes.extend(&good);
        bytes.extend(&good);
        let position = decoder.feed(&bytes).unwrap();
        assert_eq!(position.longitude, -90.0);
        assert!(decoder.buffer.is_empty());
        decoder.feed(&vec![0xff; 100000]);
        assert!(decoder.buffer.len() <= 1029);
    }
}
