const pdfInput = document.querySelector("#pdfInput");
const dropzone = document.querySelector("#dropzone");
const rawText = document.querySelector("#rawText");
const extractButton = document.querySelector("#extractButton");
const clearButton = document.querySelector("#clearButton");
const copyButton = document.querySelector("#copyButton");
const downloadButton = document.querySelector("#downloadButton");
const jsonOutput = document.querySelector("#jsonOutput");
const statusPill = document.querySelector("#statusPill");
const courseCount = document.querySelector("#courseCount");
const unitCount = document.querySelector("#unitCount");
const termCount = document.querySelector("#termCount");

let pdfJsModule = null;
let pendingFile = null;
let latestJson = null;

const PDF_JS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

async function ensurePdfJs() {
  if (!pdfJsModule) {
    pdfJsModule = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
  }

  pdfJsModule.GlobalWorkerOptions.workerSrc = PDF_JS_URL;
  return pdfJsModule;
}

function setStatus(text) {
  statusPill.textContent = text;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([),;:])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

function formatDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getCurriculumName(text, sourceName = "") {
  const match = text.match(/\bCMO\d+s\.\d{4}-[A-Za-z0-9-]+\b/i);
  if (match) {
    return match[0];
  }

  return sourceName ? sourceName.replace(/\.pdf$/i, "") : "curriculum";
}

function getRequiredUnits(text) {
  const match = text.match(/Total\s+Units\s+Required:\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function groupRows(items) {
  const rows = [];

  for (const item of items) {
    if (!item.str.trim()) {
      continue;
    }

    const [, , , , x, y] = item.transform;
    const row = findRow(rows, y);
    row.items.push({
      text: item.str,
      x,
      y,
      width: item.width || item.str.length * 4,
    });
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => ({
      ...row,
      items: row.items.sort((a, b) => a.x - b.x),
    }));
}

function findRow(rows, y) {
  const tolerance = 1.25;
  const row = rows.find((candidate) => Math.abs(candidate.y - y) <= tolerance);

  if (row) {
    row.y = (row.y * row.items.length + y) / (row.items.length + 1);
    return row;
  }

  const created = { y, items: [] };
  rows.push(created);
  return created;
}

function rowText(row) {
  return cleanText(row.items.map((item) => item.text).join(" "));
}

function parseYearHeading(text) {
  const match = cleanText(text).match(/^(\d(?:st|nd|rd|th))\s*Year$/i);
  return match ? `${match[1]} Year` : "";
}

function parseSemesterHeading(text) {
  const match = cleanText(text).match(/^(\d(?:st|nd|rd|th))\s*Semester\b/i);
  if (match) {
    return `${match[1]} Semester`;
  }

  return /^Summer\b/i.test(text) ? "Summer" : "";
}

function isHeaderRow(text) {
  return /\bCode\b/i.test(text) && /\bDescription\b/i.test(text) && /\bUnits\b/i.test(text);
}

function detectColumns(row) {
  const fields = [
    ["code", /\bCode\b/i],
    ["description", /\bDescription\b/i],
    ["units", /\bUnits\b/i],
    ["cutoff", /Cut-?off/i],
    ["prereq", /Pre-?requisites/i],
    ["grade", /\bGrade\b/i],
    ["credit", /\bCredit\b/i],
    ["status", /\bStatus\b/i],
  ];
  const anchors = {};

  for (const [name, pattern] of fields) {
    const item = row.items.find((candidate) => pattern.test(candidate.text));
    if (item) {
      anchors[name] = item.x;
    }
  }

  if (!Number.isFinite(anchors.code) || !Number.isFinite(anchors.description) || !Number.isFinite(anchors.units)) {
    return null;
  }

  if (!Number.isFinite(anchors.cutoff)) {
    anchors.cutoff = anchors.units + 45;
  }

  if (!Number.isFinite(anchors.prereq)) {
    anchors.prereq = anchors.cutoff + 70;
  }

  if (!Number.isFinite(anchors.grade)) {
    anchors.grade = anchors.prereq + 110;
  }

  if (!Number.isFinite(anchors.credit)) {
    anchors.credit = anchors.grade + 50;
  }

  if (!Number.isFinite(anchors.status)) {
    anchors.status = anchors.credit + 55;
  }

  return anchors;
}

function splitRowByColumns(row, columns) {
  const ordered = [
    ["code", columns.code],
    ["description", columns.description],
    ["units", columns.units],
    ["cutoff", columns.cutoff],
    ["prereq", columns.prereq],
    ["grade", columns.grade],
    ["credit", columns.credit],
    ["status", columns.status],
  ].sort((a, b) => a[1] - b[1]);
  const boundaries = {};

  for (let index = 0; index < ordered.length; index += 1) {
    const [name, x] = ordered[index];
    const previous = ordered[index - 1]?.[1] ?? x - 80;
    const next = ordered[index + 1]?.[1] ?? x + 140;
    boundaries[name] = {
      left: (previous + x) / 2,
      right: (x + next) / 2,
    };
  }

  const cells = Object.fromEntries(ordered.map(([name]) => [name, []]));

  for (const item of row.items) {
    const entry = ordered.find(([name]) => item.x >= boundaries[name].left && item.x < boundaries[name].right);
    if (entry) {
      cells[entry[0]].push(item.text);
    }
  }

  return Object.fromEntries(Object.entries(cells).map(([name, parts]) => [name, cleanText(parts.join(" "))]));
}

function parseNumericCell(value) {
  const match = cleanText(value).match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function isCourseCode(value) {
  const text = cleanText(value);
  const tokens = text.split(/\s+/).filter(Boolean);

  if (!tokens.length || tokens.length > 4 || text.length > 36) {
    return false;
  }

  if (!/^[A-Za-z][A-Za-z0-9./-]*$/.test(tokens[0])) {
    return false;
  }

  if (tokens.slice(1).some((token) => !/^[A-Za-z0-9./-]+$/.test(token))) {
    return false;
  }

  return /\d/.test(text)
    || /^[A-Z][A-Z0-9./-]{1,15}$/.test(text)
    || (tokens.length === 2 && tokens.every((token) => /^[A-Z]{2,8}$/.test(token)))
    || isRomanSuffixedAlphaCode(tokens);
}

function isRomanSuffixedAlphaCode(tokens) {
  if (tokens.length < 2 || tokens.length > 4) {
    return false;
  }

  const last = tokens[tokens.length - 1];
  const prefix = tokens.slice(0, -1);

  return /^[IVX]+$/.test(last)
    && prefix.every((token) => /^[A-Z]{2,10}$/.test(token));
}

function makeCourse(cells) {
  const code = cleanText(cells.code);
  const units = parseNumericCell(cells.units);

  if (!isCourseCode(code) || !units) {
    return null;
  }

  return {
    code,
    description: cleanText(cells.description),
    units,
    pre_requisites: cleanText(cells.prereq),
  };
}

function appendDescription(course, value) {
  const text = cleanText(value);
  if (!course || !text) {
    return;
  }

  course.description = cleanText(`${course.description} ${text}`);
}

function parseRows(pages, sourceName) {
  let currentYear = "";
  let currentTerm = null;
  let currentCourse = null;
  let columns = null;
  const groups = [];
  const warnings = [];
  const fullText = pages.flatMap((page) => page.rows.map(rowText)).join("\n");

  for (const page of pages) {
    for (const row of page.rows) {
      const text = rowText(row);
      const year = parseYearHeading(text);
      const semester = parseSemesterHeading(text);

      if (year) {
        currentYear = year;
        currentCourse = null;
        continue;
      }

      if (semester) {
        currentTerm = { year: currentYear, semester, courses: [] };
        groups.push(currentTerm);
        currentCourse = null;
        continue;
      }

      if (isHeaderRow(text)) {
        columns = detectColumns(row);
        currentCourse = null;
        continue;
      }

      if (!columns || !currentTerm || isNoiseText(text)) {
        continue;
      }

      const cells = splitRowByColumns(row, columns);
      const course = makeCourse(cells);

      if (course) {
        currentTerm.courses.push(course);
        currentCourse = course;
        if (!course.description) {
          warnings.push(`${currentYear} ${currentTerm.semester}: ${course.code} has an empty description.`);
        }
        continue;
      }

      if (isCourseCode(cells.code) && cells.description) {
        const pending = {
          code: cleanText(cells.code),
          description: cleanText(cells.description),
          units: 0,
          pre_requisites: "",
        };
        currentTerm.courses.push(pending);
        currentCourse = pending;
        continue;
      }

      if (cells.description) {
        appendDescription(currentCourse, cells.description);
        continue;
      }

      if (cells.units && currentCourse && !currentCourse.units) {
        currentCourse.units = parseNumericCell(cells.units);
        currentCourse.pre_requisites = cleanText(cells.prereq);
      }
    }
  }

  const cleanedGroups = groups
    .map((group) => ({
      ...group,
      courses: group.courses.filter((course) => course.code && course.units),
    }))
    .filter((group) => group.courses.length);
  const curriculumName = getCurriculumName(fullText, sourceName);
  const totalUnitsRequired = getRequiredUnits(fullText);

  addValidationWarnings(cleanedGroups, totalUnitsRequired, warnings);

  return {
    data: {
      metadata: {
        curriculum: curriculumName,
        total_units_required: totalUnitsRequired,
        scraping_date: formatDate(),
        filename: `${curriculumName}.json`,
      },
      curriculum: cleanedGroups,
    },
    warnings,
  };
}

function isNoiseText(text) {
  return /^Total Units Required:/i.test(text)
    || /^Evaluated By:/i.test(text)
    || /^Page\s+\d+\s+of\s+\d+/i.test(text)
    || /^Code Description Units/i.test(text)
    || /^Student\b|^Course\b|^Year Level\b|^Birthdate\b/i.test(text)
    || /^CRONASIA FOUNDATION/i.test(text)
    || /^Andres-Dizon/i.test(text)
    || /^General Santos/i.test(text)
    || /^Telephone No\./i.test(text);
}

function addValidationWarnings(groups, requiredUnits, warnings) {
  const courses = groups.flatMap((group) => group.courses);
  const extractedUnits = courses.reduce((sum, course) => sum + course.units, 0);

  if (requiredUnits && extractedUnits !== requiredUnits) {
    warnings.push(`Unit total mismatch: extracted ${extractedUnits}, required ${requiredUnits}.`);
  }

  for (const group of groups) {
    if (!group.year || !group.semester) {
      warnings.push(`A term has incomplete year/semester metadata.`);
    }
  }

  for (const course of courses) {
    if (!course.description) {
      warnings.push(`${course.code} has an empty description.`);
    }
  }
}

async function extractVisualPdf(file) {
  const pdfjsLib = await ensurePdfJs();
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({
      pageNumber,
      rows: groupRows(content.items),
    });
  }

  return parseRows(pages, file.name);
}

function renderResult(result) {
  latestJson = result.data;
  const courses = latestJson.curriculum.flatMap((group) => group.courses);

  jsonOutput.textContent = JSON.stringify(latestJson, null, 2);
  courseCount.textContent = courses.length;
  unitCount.textContent = courses.reduce((sum, course) => sum + course.units, 0);
  termCount.textContent = latestJson.curriculum.length;
  copyButton.disabled = false;
  downloadButton.disabled = false;

  rawText.value = result.warnings.length
    ? `Warnings:\n- ${result.warnings.join("\n- ")}`
    : "No warnings found.";
}

function clearOutput() {
  pendingFile = null;
  latestJson = null;
  rawText.value = "";
  jsonOutput.textContent = "";
  courseCount.textContent = "0";
  unitCount.textContent = "0";
  termCount.textContent = "0";
  copyButton.disabled = true;
  downloadButton.disabled = true;
  extractButton.disabled = true;
  pdfInput.value = "";
  setStatus("Idle");
}

async function handleFile(file) {
  if (!file) {
    return;
  }

  if (file.type !== "application/pdf") {
    rawText.value = "Please choose a PDF file.";
    setStatus("Needs review");
    return;
  }

  pendingFile = file;
  extractButton.disabled = false;
  rawText.value = `Ready: ${file.name}`;
  setStatus("Ready");
}

extractButton.addEventListener("click", async () => {
  if (!pendingFile) {
    return;
  }

  try {
    setStatus("Extracting");
    renderResult(await extractVisualPdf(pendingFile));
    setStatus("Extracted");
  } catch (error) {
    rawText.value = `Extraction failed: ${error.message}`;
    setStatus("Needs review");
  }
});

clearButton.addEventListener("click", clearOutput);

copyButton.addEventListener("click", async () => {
  if (!latestJson) {
    return;
  }

  await navigator.clipboard.writeText(JSON.stringify(latestJson, null, 2));
  setStatus("Copied");
});

downloadButton.addEventListener("click", () => {
  if (!latestJson) {
    return;
  }

  const blob = new Blob([JSON.stringify(latestJson, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = latestJson.metadata.filename;
  link.click();
  URL.revokeObjectURL(url);
});

pdfInput.addEventListener("change", (event) => {
  handleFile(event.target.files[0]);
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-dragging");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("is-dragging");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragging");
  handleFile(event.dataTransfer.files[0]);
});
