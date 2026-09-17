Health Net eligibility is available only for MedRevenu (`projectId=medrevenue`).

MedRevenue accepts a three-character suffix present in only one of the input/result Member IDs. The shared base must match exactly after whitespace, hyphen and case normalization; other mismatches still fail. The output Member column retains the full portal Member #, including its suffix.

Member identity extraction uses rendered text and skips standalone label separators. If the requested and extracted IDs still differ, the run downloads `healthnet-member-comparison-row-N.json` with both values for diagnosis. This file contains member identifiers. Mismatched results are not written as verified eligibility results.

After submitting login, the bot waits for either Text Message verification or the signed-in dashboard/eligibility form. If Health Net accepts the session without OTP, it immediately continues to Eligibility. When the dashboard appears, including after OTP verification, the bot clicks its Eligibility link before starting member checks.

Input: Primary Insurance Name = Health Net, Member ID (or Primary Insurance ID#), and DOB. Project rows for other projects and named payers other than Health Net are excluded. Credentials use Email Address (or Username), Password, and Link (HTTPS login URL); Project and Portal columns isolate rows in shared credential workbooks.

Legacy input is also supported: DOS, Patient Name, DOB, Insurance, and `Primary Insurance Name"`. In this layout, Insurance contains Health Net and the mislabeled `Primary Insurance Name"` column contains the member ID. This mapping applies only when no standard member ID column exists.

The supplied Eligibility link `a.eligibility[href="/careconnect/eligibility/bulkChecker"]` takes priority over generic navigation. The form fills workbook DOS first (when supplied), then Member ID and DOB. Masked dates are cleared with keyboard events and entered as digits so the portal inserts separators; retained dates are validated before Check Eligibility. Without workbook DOS, the portal's existing DOS is preserved.

Login uses the supplied username, Continue, password, Login, Text Message, and Send Code elements. The existing frontend `otp_request`/job-input mechanism collects the SMS code. No other portal's OTP implementation is modified. The source document omits the OTP input and verification button, so those two controls currently use accessible-label/autocomplete fallbacks. Live verification and the missing OTP HTML are still needed to confirm those selectors.

After entering Member ID and DOB, the inquiry clicks the Check Eligibility submit input (`name="check"`), then the visible `span.viewdetails` to open the result. Already expanded responses are also supported. Extraction waits for PPG Information and Eligibility History, reads Name under PPG Information into Plan Name, and maps the history table's Start Date, End Date, and Product Name to Eff Date, End Date, and Plan Type. The full eligibility-for-today message is preserved, including the page's actual date. Every history row is retained in table order, with matching ` | ` separators across Eff Date, End Date, and Plan Type; missing end dates use `-`. No history row is assumed to represent today. Existing MedRevenu output columns remain and Health Net adds Patient Eligibility for Today, Member, Patient Name, Plan Name, and error as needed.

Browser fixtures cover SMS selection and frontend OTP submission, multiple members, PPG versus patient name, history alignment, workbook output, and project/payer isolation. They do not constitute a live Health Net run.
