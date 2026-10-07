/*
 * Exports:
 * - serviceReleases (default): independently sealed service database releases.
 */
const serviceReleases = Object.freeze({
  initialService: Object.freeze({ version: 1, fingerprint: "9f8606f45c0734950efa35f11140110d4c45e489ae473c4eae5657924e0ca01b" }),
  retireStartupFailure: Object.freeze({ version: 2, fingerprint: "1d464f5f6ca8bcb4bca405f6706d6e5d64d32b9e0952a0c37ca01e81d05e774b" }),
});
export default serviceReleases;
