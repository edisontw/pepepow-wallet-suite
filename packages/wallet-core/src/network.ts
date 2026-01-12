// =============================================================
//  PEPEPOW NETWORK PARAMS  (CONFIRMED FROM chainparams.cpp)
// =============================================================
// pubKeyHash : 55 (0x37) -> 'X'
// scriptHash : 16 (0x10) -> '7'
// wif        : 204 (0xCC)
// SLIP-0044  : 5 -> m/44'/5'/0'/0/0
// =============================================================

// Define PEPEPOW network params (PLACEHOLDER; set correct version bytes!)
export interface PepepowNetwork {
  messagePrefix: string;
  bech32?: string;
  bip32: { public: number; private: number };
  pubKeyHash: number; // P2PKH version byte
  scriptHash: number; // P2SH version byte
  wif: number;        // WIF version byte
}

export const PEPEPOW: PepepowNetwork = {
  // Confirmed from chainparams.cpp
  // pubKeyHash : 55 (0x37) -> 'X'
  // scriptHash : 16 (0x10) -> '7'
  // wif        : 204 (0xCC)
  messagePrefix: '\\x18PEPEPOW Signed Message:\\n',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 }, // xpub/xprv
  pubKeyHash: 0x37,
  scriptHash: 0x10,
  wif: 0xCC
};


export const COMPAT_BITCOIN: PepepowNetwork = {
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80
};
