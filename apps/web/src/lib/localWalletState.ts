export type LocalWalletState = "missing" | "watchOnly" | "mnemonicOnly" | "ready";

/** Describes local restore material only; a server-side public address is not a wallet key. */
export function getLocalWalletState(address: string | null | undefined, mnemonic: string | null | undefined): LocalWalletState {
  const hasAddress = Boolean(address?.trim());
  const hasMnemonic = Boolean(mnemonic?.trim());
  if (hasAddress && hasMnemonic) return "ready";
  if (hasAddress) return "watchOnly";
  if (hasMnemonic) return "mnemonicOnly";
  return "missing";
}

export function canCreateLocalWallet(...values: Array<string | null | undefined>) {
  return values.every((value) => !value?.trim());
}
