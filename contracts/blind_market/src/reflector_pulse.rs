#![allow(dead_code)]

use soroban_sdk::{contractclient, contracterror, contracttype, Address, Symbol};

#[contractclient(name = "ReflectorPulseClient")]
pub trait Contract {
    fn decimals() -> u32;
    fn lastprice(asset: Asset) -> Option<PriceData>;
}

#[contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracterror]
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub enum Error {
    AlreadyInitialized = 0,
    Unauthorized = 1,
    AssetMissing = 2,
    AssetAlreadyExists = 3,
    InvalidConfigVersion = 4,
    InvalidTimestamp = 5,
    InvalidUpdateLength = 6,
    AssetLimitExceeded = 7,
    InvalidPricesUpdate = 8,
}
