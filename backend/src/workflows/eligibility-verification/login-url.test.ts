import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { readMediCalCredentials } from './portals/medi-cal/data';
import { readHealthNetCredentials } from './portals/healthnet/data';
import { normalizeEligibilityLoginUrl } from './login-url';

test('both MedRevenu portals honor workbook URLs and select their own credential row', async () => {
  for (const url of ['http://portal.example.test/login', 'https://portal.example.test/login?next=inquiry', 'portal.example.test/login']) {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Credentials').addRows([
      ['Project', 'Portal', 'URL', 'User Name', 'Password'],
      ['Minimax', 'medical', url, 'excluded', 'excluded'],
      ['Medrevenu', 'medical', url, 'medical-user', 'test'],
      ['Medrevenu', 'healthnet', url, 'healthnet-user', 'test'],
    ]);
    const file = new File([new Uint8Array(await book.xlsx.writeBuffer())], 'credentials.xlsx');
    for (const [reader, username] of [[readMediCalCredentials, 'medical-user'], [readHealthNetCredentials, 'healthnet-user']] as const) {
      const credentials = await reader(file);
      assert.equal(credentials.username, username);
      assert.equal(credentials.loginUrl, url.startsWith('http') ? url : `https://${url}`);
    }
  }
});

test('invalid login URL schemes are rejected before browser navigation', () => {
  for (const url of ['', 'javascript:alert(1)', 'file:///tmp/login', 'https://']) {
    assert.throws(() => normalizeEligibilityLoginUrl(url), /URL/);
  }
});
