//! NTRIP session core. One task per rover, one upstream caster socket, GGA forwarded.
#![forbid(unsafe_code)]

pub mod caster;
pub mod config;
pub mod geo;
pub mod nmea;
pub mod onboarding;
pub mod registry;
pub mod rtcm;
pub mod server;
pub mod sourcetable;
pub mod upstream;

pub use config::Config;
pub use server::serve;
