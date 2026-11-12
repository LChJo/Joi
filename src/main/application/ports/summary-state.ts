/** Private retry metadata contains neither transcript content nor transport credentials. */
export interface SummaryRetryState {
  routeKey: string;
  failures: number;
  until: number;
}
