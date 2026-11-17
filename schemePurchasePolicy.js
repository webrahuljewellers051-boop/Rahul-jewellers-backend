// Gold-only scheme: one eligible purchase cannot exceed verified deposits.
// Invoice/product value excludes the separately waived making charges.
export function withinVerifiedDeposits(purchaseAmount, verifiedDeposits) {
  const purchase = Number(purchaseAmount);
  const limit = Number(verifiedDeposits);
  return Number.isFinite(purchase) && purchase > 0 &&
    Number.isFinite(limit) && limit > 0 && purchase <= limit;
}
