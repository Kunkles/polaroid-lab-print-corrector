/* Single source of truth for the app / correction version.
   BUMP THIS whenever you change anything that affects the correction, the
   film model, or the calibration — so a print can always be traced back to
   the exact version that produced it.

   Convention (semantic-ish): MAJOR.MINOR.PATCH
     PATCH — tweaks that don't change correction output (UI, docs)
     MINOR — correction/calibration behavior changes
     MAJOR — a new calibration that you re-shoot charts for

   It is shown in the app header, printed on the calibration charts, and baked
   into export filenames and the .cube title. */
const APP_VERSION = '1.4.3';
const APP_NAME = 'Polaroid Lab Print Corrector';
const APP_AUTHOR = 'Ryan Kunkleman';
const APP_REPO = 'https://github.com/Kunkles/polaroid-lab-print-corrector';
