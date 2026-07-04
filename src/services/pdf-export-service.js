import PDFDocument from 'pdfkit';
import { getEnergyReport } from './report-service.js';
import { getDeviceEfficiency } from './efficiency-score-service.js';

const COLORS = {
  primary: '#2563eb',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  text: '#1f2937',
  textLight: '#6b7280',
  border: '#e5e7eb',
  bgBlue: '#eff6ff',
  bgGreen: '#ecfdf5',
};

function drawHeader(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 90).fill(COLORS.primary);
  doc.fill('#ffffff').fontSize(22).font('Helvetica-Bold').text(title, 40, 28);
  doc.fontSize(10).font('Helvetica').text(subtitle, 40, 56);
  doc.moveDown(2);
}

function drawSectionTitle(doc, text, y) {
  doc.fill(COLORS.text).fontSize(12).font('Helvetica-Bold').text(text, 40, y);
  doc.moveTo(40, y + 18).lineTo(doc.page.width - 40, y + 18).strokeColor(COLORS.border).lineWidth(0.5).stroke();
  return y + 28;
}

function drawStatRow(doc, label, value, y, opts = {}) {
  const x = opts.x || 40;
  const w = opts.width || 250;
  doc.fill(COLORS.textLight).fontSize(9).font('Helvetica').text(label, x, y, { width: w });
  doc.fill(COLORS.text).fontSize(10).font('Helvetica-Bold').text(String(value), x + w, y, { width: w, align: 'right' });
  return y + 16;
}

function drawTable(doc, headers, rows, startY, opts = {}) {
  const x = opts.x || 40;
  const colWidths = opts.colWidths || headers.map(() => Math.floor((doc.page.width - 80) / headers.length));
  const rowHeight = 20;
  let y = startY;

  // Header row
  doc.rect(x, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(COLORS.bgBlue);
  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    doc.fill(COLORS.primary).fontSize(8).font('Helvetica-Bold').text(headers[i], cx + 4, y + 5, { width: colWidths[i] - 8 });
    cx += colWidths[i];
  }
  y += rowHeight;

  // Data rows
  for (const row of rows) {
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = 50;
      // Re-draw header on new page
      doc.rect(x, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(COLORS.bgBlue);
      cx = x;
      for (let i = 0; i < headers.length; i++) {
        doc.fill(COLORS.primary).fontSize(8).font('Helvetica-Bold').text(headers[i], cx + 4, y + 5, { width: colWidths[i] - 8 });
        cx += colWidths[i];
      }
      y += rowHeight;
    }

    doc.fill('#ffffff').rect(x, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill();
    doc.rect(x, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(COLORS.border === '#e5e7eb' ? '#f9fafb' : '#f9fafb');
    cx = x;
    for (let i = 0; i < headers.length; i++) {
      doc.fill(COLORS.text).fontSize(8).font('Helvetica').text(String(row[i] ?? '-'), cx + 4, y + 5, { width: colWidths[i] - 8 });
      cx += colWidths[i];
    }
    y += rowHeight;
  }

  return y;
}

export function generateEnergyReportPdf({ startDate, endDate, granularity, registrationNos, user }) {
  return new Promise((resolve, reject) => {
    try {
      const report = getEnergyReport({ startDate, endDate, granularity, registrationNos });

      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 40, right: 40 },
        info: {
          Title: `Energy Report ${report.startDate} - ${report.endDate}`,
          Author: 'SolarPRO',
          Subject: 'Energy Production Report',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      drawHeader(doc, 'SolarPRO - Energy Report', `${report.startDate} / ${report.endDate} | ${report.granularity.toUpperCase()}`);

      let y = 110;

      // Summary
      y = drawSectionTitle(doc, 'Summary', y);
      y = drawStatRow(doc, 'Total Yield', `${report.summary.total} ${report.summary.unit}`, y);
      y = drawStatRow(doc, 'Active Devices', `${report.summary.activeDeviceCount} / ${report.summary.deviceCount}`, y);
      y = drawStatRow(doc, 'Average per Period', `${report.summary.averagePerActivePoint} ${report.summary.unit}`, y);
      y = drawStatRow(doc, 'Best Period', report.summary.best ? `${report.summary.best.label}: ${report.summary.best.value} ${report.summary.unit}` : '-', y);
      y += 10;

      // Time series
      if (report.series?.length > 0) {
        y = drawSectionTitle(doc, 'Production Data', y);
        const seriesHeaders = ['Period', 'Value (kWh)'];
        const seriesRows = report.series.map((s) => [s.label, Number(s.value).toFixed(2)]);
        y = drawTable(doc, seriesHeaders, seriesRows, y, { colWidths: [250, 250] });
        y += 10;
      }

      // Device breakdown
      if (report.devices?.length > 0) {
        if (y > doc.page.height - 200) {
          doc.addPage();
          y = 50;
        }
        y = drawSectionTitle(doc, 'Device Breakdown', y);
        const devHeaders = ['Device', 'Plant', 'Yield (kWh)', 'Share %'];
        const devRows = report.devices.map((d) => [
          d.deviceName || d.registrationNo,
          d.plantName || '-',
          Number(d.total).toFixed(1),
          `${d.sharePercent}%`,
        ]);
        y = drawTable(doc, devHeaders, devRows, y, { colWidths: [150, 150, 100, 100] });
      }

      // Footer
      const footerY = doc.page.height - 35;
      doc.fontSize(7).fill(COLORS.textLight).font('Helvetica')
        .text(`Generated by SolarPRO | User: ${user?.username || user?.displayName || 'N/A'} | ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, 40, footerY, { width: doc.page.width - 80, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export function generateEfficiencyReportPdf({ startDate, endDate, registrationNos, user }) {
  return new Promise((resolve, reject) => {
    try {
      const report = getDeviceEfficiency({ startDate, endDate, registrationNos });

      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 40, right: 40 },
        info: {
          Title: `Efficiency Report ${report.startDate} - ${report.endDate}`,
          Author: 'SolarPRO',
          Subject: 'Device Efficiency Report',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.rect(0, 0, doc.page.width, 90).fill('#059669');
      doc.fill('#ffffff').fontSize(22).font('Helvetica-Bold').text('SolarPRO - Efficiency Report', 40, 28);
      doc.fontSize(10).font('Helvetica').text(`${report.startDate} / ${report.endDate} | ${report.spanDays} days`, 40, 56);

      let y = 110;

      // Summary
      y = drawSectionTitle(doc, 'System Summary', y);
      y = drawStatRow(doc, 'System Efficiency', report.summary.systemEfficiency !== null ? `${report.summary.systemEfficiency}%` : 'N/A', y);
      y = drawStatRow(doc, 'Total Yield', `${report.summary.totalYield} kWh`, y);
      y = drawStatRow(doc, 'Total Rated Power', `${report.summary.totalRatedPower} kW`, y);
      y = drawStatRow(doc, 'Devices with Score', `${report.summary.devicesWithScore} / ${report.summary.deviceCount}`, y);
      y = drawStatRow(doc, 'Anomalies Detected', `${report.summary.anomalyCount}`, y);
      y += 10;

      // Device ranking
      const ranked = report.devices
        .filter((d) => d.efficiency.score !== null)
        .sort((a, b) => b.efficiency.score - a.efficiency.score);

      if (ranked.length > 0) {
        y = drawSectionTitle(doc, 'Device Ranking', y);
        const rankHeaders = ['#', 'Device', 'Plant', 'Score %', 'Yield (kWh)', 'Grade'];
        const rankRows = ranked.map((d, i) => [
          String(i + 1),
          d.deviceName || d.registrationNo,
          d.plantName || '-',
          `${d.efficiency.score}`,
          `${d.stats.totalYield}`,
          d.efficiency.grade,
        ]);
        y = drawTable(doc, rankHeaders, rankRows, y, { colWidths: [25, 130, 110, 55, 75, 60] });
        y += 10;
      }

      // Anomalies
      if (report.anomalies?.length > 0) {
        if (y > doc.page.height - 150) {
          doc.addPage();
          y = 50;
        }
        y = drawSectionTitle(doc, 'Anomalies', y);
        const anomHeaders = ['Device', 'Score %', 'Reason'];
        const anomRows = report.anomalies.map((a) => [
          a.deviceName || a.registrationNo,
          `${a.efficiencyScore}`,
          a.reason,
        ]);
        y = drawTable(doc, anomHeaders, anomRows, y, { colWidths: [150, 70, 280] });
      }

      // Footer
      const footerY = doc.page.height - 35;
      doc.fontSize(7).fill(COLORS.textLight).font('Helvetica')
        .text(`Generated by SolarPRO | User: ${user?.username || user?.displayName || 'N/A'} | ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, 40, footerY, { width: doc.page.width - 80, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
