export function qualityDifferenceInterval(candidateSuccesses: number, baselineSuccesses: number, pairs: number): [number,number] | null {
  if (pairs===0) return null;
  // Wilson intervals remain bounded for small cohorts and all-pass arms.
  const interval=(successes:number): [number,number]=>{
    const z=1.96;
    const ratio=successes/pairs;
    const denominator=1+z*z/pairs;
    const center=(ratio+z*z/(2*pairs))/denominator;
    const margin=z*Math.sqrt(ratio*(1-ratio)/pairs+z*z/(4*pairs*pairs))/denominator;
    return [center-margin,center+margin];
  };
  const candidate=interval(candidateSuccesses), baseline=interval(baselineSuccesses);
  return [Math.max(-1,candidate[0]-baseline[1]),Math.min(1,candidate[1]-baseline[0])];
}
