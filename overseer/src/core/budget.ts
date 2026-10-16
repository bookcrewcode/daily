// A spend that can't be read counts as over the cap: the safe side is templates.
export function overCap(spent: number | null, cap: number): boolean {
  return spent === null || spent >= cap;
}
