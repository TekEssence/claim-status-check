# Office Ally Payment EOB Download

Select **Payment EOB Download → Office Ally**, upload the credential workbook, and click **Start Job**. No project, control log, or OTP is required.

The workbook must contain exactly one account row with these headers:

| Login URL | Username | Password | Start Date | End Date |
| --- | --- | --- | --- | --- |
| https://www.officeally.com/sLogin.aspx | your-username | your-password | 09/07/2026 | 09/11/2026 |

Use full MM/DD/YYYY dates or Excel date cells. Both dates are required. Every calendar date in the inclusive range is processed, including weekends when selected. There is no automatic previous-week calculation.

The job logs in, dismisses the optional referral popup, opens Download EOB / ERA 835, and searches each date using Daily / All. It downloads every report row regardless of the portal's previously-downloaded color.

The downloadable `OfficeAllyPaymentEobDownloads.zip` delivers this folder:

```text
OfficeAllyPaymentEobDownloads/
  office_ally_download_status.xlsx
  <original-filename-1>.zip
  <original-filename-2>.zip
```

The outer ZIP is the application's delivery package. Original portal ZIP files inside it retain their names and bytes; their contents are never extracted or converted. There are no date, run, or PDF subfolders.

The status workbook has Date, Report Type, File ID, File Name, EOB ID, # Records, and Office Ally Download Status. File ID and EOB ID remain text. Each portal report has one row. Empty dates are recorded in job logs without creating fictitious report rows.

Downloaded means the ZIP was saved successfully. Identical duplicate files are marked Already saved. Different files sharing a filename are marked Failed rather than overwritten or renamed. Download errors appear in the logs and workbook; date-search failures appear in logs and fail the overall job. Partial outputs are packaged on failure or cancellation after the browser starts. A new run has separate internal job storage even though its delivered folder has the same name.

Implementation is based on the supplied Office Ally HTML. A live account test is still needed to verify authentication redirects and portal download responses.

Developer checks: run the `office-ally.test.ts` tests with the repository's tsx test runner. The simulated browser test in `browser.test.ts` requires installed Chrome and `OFFICE_ALLY_BROWSER_TEST=1`; all portal responses are intercepted locally and dummy credentials are used.
