import { createObjectCsvWriter } from 'csv-writer';
import { mkdir, writeFile, appendFile } from 'fs/promises';
import { dirname } from 'path';

const COLUMNS = [
  { id: 'business_name', title: 'business_name' },
  { id: 'domain', title: 'domain' },
  { id: 'country', title: 'country' },
  { id: 'city', title: 'city' },
  { id: 'email', title: 'email' },
  { id: 'email_type', title: 'email_type' },
  { id: 'confidence', title: 'confidence' },
  { id: 'relevance_score', title: 'relevance_score' },
  { id: 'source_url', title: 'source_url' },
  { id: 'discovered_by_query', title: 'discovered_by_query' },
];

const HEADER_LINE = COLUMNS.map((c) => c.title).join(',') + '\n';

/**
 * Escape a CSV field: wrap in quotes if it contains comma, quote, or newline.
 */
function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Convert a row object to a CSV line.
 */
function rowToCsvLine(row) {
  return COLUMNS.map((c) => csvEscape(row[c.id])).join(',') + '\n';
}

/**
 * Write leads to a CSV file (full overwrite). Creates parent directory if needed.
 * @param {string} filePath - Output path (e.g. leads.csv)
 * @param {Array<object>} rows - Array of lead objects with keys matching COLUMNS
 */
export async function writeLeadsCsv(filePath, rows) {
  await mkdir(dirname(filePath), { recursive: true });
  const csvWriter = createObjectCsvWriter({
    path: filePath,
    header: COLUMNS,
  });
  await csvWriter.writeRecords(rows);
}

/**
 * Write just the CSV header to a file (overwriting). Call once at start.
 * @param {string} filePath
 */
export async function initLeadsCsv(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, HEADER_LINE, 'utf-8');
}

/**
 * Append rows to an existing CSV file (no header). Call after each domain.
 * Safe to call concurrently -- each call is a single appendFile.
 * @param {string} filePath
 * @param {Array<object>} rows
 */
export async function appendLeadsCsv(filePath, rows) {
  if (!rows.length) return;
  const lines = rows.map(rowToCsvLine).join('');
  await appendFile(filePath, lines, 'utf-8');
}

export { COLUMNS };
export default writeLeadsCsv;
