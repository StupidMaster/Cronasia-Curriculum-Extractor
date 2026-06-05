const pdfInput = document.querySelector("#pdfInput");
const dropzone = document.querySelector("#dropzone");
const rawText = document.querySelector("#rawText");
const extractButton = document.querySelector("#extractButton");
const clearButton = document.querySelector("#clearButton");
const copyButton = document.querySelector("#copyButton");
const downloadButton = document.querySelector("#downloadButton");
const loadSampleButton = document.querySelector("#loadSampleButton");
const jsonOutput = document.querySelector("#jsonOutput");
const statusPill = document.querySelector("#statusPill");
const courseCount = document.querySelector("#courseCount");
const unitCount = document.querySelector("#unitCount");
const termCount = document.querySelector("#termCount");
const sampleText = document.querySelector("#sampleText");

let latestJson = null;
let pdfJsModule = null;
let uploadedCurriculumName = "";

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

function formatDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":");
}

function cleanText(value) {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([),;:])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

function getCurriculumName(text, sourceName = "") {
  const match = text.match(/\bCMO\d+s\.\d{4}-[A-Z]+\b/i);
  if (match) {
    return match[0];
  }

  return sourceName
    ? sourceName.replace(/\.pdf$/i, "")
    : "curriculum";
}

function getRequiredUnits(text) {
  const match = text.match(/Total\s+Units\s+Required:\s*(\d+)/i);
  return match ? Number(match[1]) : 152;
}

function isNoiseLine(line) {
  return /^(Code|Description|Units|Cut-off|Pre-requisites|Grade|Credit|Status)$/i.test(line)
    || /^Page\s+\d+\s+of\s+\d+/i.test(line)
    || /^Total\s+Units\s+Required:/i.test(line)
    || /^Evaluated\s+By:/i.test(line)
    || /^CRONASIA\s+FOUNDATION/i.test(line)
    || /^Andres-Dizon/i.test(line)
    || /^General\s+Santos/i.test(line)
    || /^Telephone\s+No\./i.test(line)
    || /^Student\b|^Course\b|^Year\s+Level\b|^Birthdate\b/i.test(line)
    || /^Earned:\s*\d+/i.test(line)
    || /^Credited:/i.test(line);
}

function parseCourseLine(line) {
  const firstCodePiece = "[A-Za-z][A-Za-z0-9./-]*";
  const nextCodePiece = "[A-Za-z0-9./-]+";
  const columnMatch = line.match(
    new RegExp(`^\\s*(?<code>${firstCodePiece}(?:\\s+${nextCodePiece}){0,3})\\s{2,}(?<description>.+?)\\s{2,}(?<units>\\d+)\\s+(?<cutoff>\\d(?:\\.\\d)?)(?<tail>.*?)\\s+(?<status>Enrolled|Passed|Failed|Credited|Taken)\\s*$`)
  );

  if (columnMatch?.groups) {
    const code = cleanText(columnMatch.groups.code);

    if (isLikelyCourseCode(code)) {
      return {
        code,
        description: cleanText(columnMatch.groups.description),
        units: Number(columnMatch.groups.units),
        pre_requisites: extractPreRequisites(columnMatch.groups.tail || ""),
      };
    }
  }

  const incompleteColumnMatch = line.match(
    new RegExp(`^\\s*(?<code>${firstCodePiece}(?:\\s+${nextCodePiece}){0,3})\\s{2,}(?<description>.+?)\\s{2,}(?<units>\\d+)\\s+(?<cutoff>\\d(?:\\.\\d)?)(?<tail>.*?)\\s*$`)
  );

  if (incompleteColumnMatch?.groups) {
    const code = cleanText(incompleteColumnMatch.groups.code);

    if (isLikelyCourseCode(code)) {
      const parsedBody = parseIncompleteLooseCourseBody([
        incompleteColumnMatch.groups.description,
        incompleteColumnMatch.groups.units,
        incompleteColumnMatch.groups.cutoff,
        incompleteColumnMatch.groups.tail || "",
      ].join(" "));

      if (parsedBody) {
        return {
          code,
          description: parsedBody.description,
          units: parsedBody.units,
          pre_requisites: parsedBody.pre_requisites,
        };
      }

      return {
        code,
        description: cleanText(incompleteColumnMatch.groups.description),
        units: Number(incompleteColumnMatch.groups.units),
        pre_requisites: extractIncompletePreRequisites(incompleteColumnMatch.groups.tail || ""),
      };
    }
  }

  const trimmedLine = line.trim();
  const tokens = trimmedLine.split(/\s+/);

  const candidates = [];

  for (let codeTokenCount = 1; codeTokenCount <= Math.min(4, tokens.length - 5); codeTokenCount += 1) {
    const code = cleanText(tokens.slice(0, codeTokenCount).join(" "));

    if (!isLikelyCourseCode(code)) {
      continue;
    }

    const rest = tokens.slice(codeTokenCount).join(" ");
    const parsedBody = parseLooseCourseBody(rest);

    if (parsedBody) {
      candidates.push({
        code,
        description: parsedBody.description,
        units: parsedBody.units,
        pre_requisites: parsedBody.pre_requisites,
      });
      continue;
    }

    const incompleteBody = parseIncompleteLooseCourseBody(rest);

    if (incompleteBody) {
      candidates.push({
        code,
        description: incompleteBody.description,
        units: incompleteBody.units,
        pre_requisites: incompleteBody.pre_requisites,
      });
    }
  }

  return chooseBestCourseCandidate(candidates);
}

function parseCourseDetailLine(line, code) {
  if (!isLikelyCourseCode(code)) {
    return null;
  }

  const columnMatch = line.match(
    /^\s*(?<description>.+?)\s{2,}(?<units>\d+)\s+(?<cutoff>\d(?:\.\d)?)(?<tail>.*?)\s+(?<status>Enrolled|Passed|Failed|Credited|Taken)\s*$/
  );

  if (columnMatch?.groups) {
    return {
      code,
      description: cleanText(columnMatch.groups.description),
      units: Number(columnMatch.groups.units),
      pre_requisites: extractPreRequisites(columnMatch.groups.tail || ""),
    };
  }

  const parsedBody = parseLooseCourseBody(line);

  if (!parsedBody) {
    return null;
  }

  return {
    code,
    description: parsedBody.description,
    units: parsedBody.units,
    pre_requisites: parsedBody.pre_requisites,
  };
}

function parseCourseStartLine(line) {
  const firstCodePiece = "[A-Za-z][A-Za-z0-9./-]*";
  const nextCodePiece = "[A-Za-z0-9./-]+";
  const match = line.match(
    new RegExp(`^\\s*(?<code>${firstCodePiece}(?:\\s+${nextCodePiece}){0,3})\\s{2,}(?<description>.+?)\\s*$`)
  );

  if (!match?.groups) {
    return null;
  }

  const code = cleanText(match.groups.code);
  const description = cleanText(match.groups.description);

  if (!isLikelyCourseCode(code) || !description || /\b(Enrolled|Passed|Failed|Credited|Taken)\b/.test(description)) {
    return null;
  }

  return { code, description };
}

function parseCourseTailLine(line, pendingCourse) {
  const columnMatch = line.match(
    /^\s*(?<units>\d+)\s+(?<cutoff>\d(?:\.\d)?)(?<tail>.*?)\s+(?<status>Enrolled|Passed|Failed|Credited|Taken)\s*$/
  );

  if (!columnMatch?.groups) {
    const parsedTail = parseLooseCourseTail(line);

    if (!parsedTail) {
      return null;
    }

    return {
      code: pendingCourse.code,
      description: pendingCourse.description,
      units: parsedTail.units,
      pre_requisites: parsedTail.pre_requisites,
    };
  }

  return {
    code: pendingCourse.code,
    description: pendingCourse.description,
    units: Number(columnMatch.groups.units),
    pre_requisites: extractPreRequisites(columnMatch.groups.tail || ""),
  };
}

function parseLooseCourseBody(value) {
  const tokens = value.trim().split(/\s+/).filter(Boolean);

  if (tokens.length < 5 || !isStatusToken(tokens[tokens.length - 1])) {
    return null;
  }

  const credit = tokens[tokens.length - 2];
  const grade = tokens[tokens.length - 3];
  if (!/^\d+$/.test(credit) || !isGradeToken(grade)) {
    return null;
  }

  const content = tokens.slice(0, -3);
  const unitCutoff = findUnitCutoffPair(content);
  if (!unitCutoff || unitCutoff.unitsIndex === 0) {
    return null;
  }

  return {
    description: cleanText(content.slice(0, unitCutoff.unitsIndex).join(" ")),
    units: Number(content[unitCutoff.unitsIndex]),
    pre_requisites: cleanText(content.slice(unitCutoff.cutoffIndex + 1).join(" ")),
  };
}

function parseLooseCourseTail(value) {
  const tokens = value.trim().split(/\s+/).filter(Boolean);

  if (tokens.length < 4 || !isStatusToken(tokens[tokens.length - 1])) {
    return null;
  }

  const credit = tokens[tokens.length - 2];
  const grade = tokens[tokens.length - 3];
  if (!/^\d+$/.test(credit) || !isGradeToken(grade)) {
    return null;
  }

  const content = tokens.slice(0, -3);
  const unitCutoff = findUnitCutoffPair(content);
  if (!unitCutoff) {
    return null;
  }

  return {
    units: Number(content[unitCutoff.unitsIndex]),
    pre_requisites: cleanText(content.slice(unitCutoff.cutoffIndex + 1).join(" ")),
  };
}

function parseIncompleteLooseCourseBody(value) {
  const tokens = value.trim().split(/\s+/).filter(Boolean);

  if (tokens.length < 3) {
    return null;
  }

  const unitCutoff = findFirstUnitCutoffPair(tokens) || findUnitCutoffPair(tokens);
  if (!unitCutoff || unitCutoff.unitsIndex === 0) {
    return null;
  }

  return {
    description: cleanText(tokens.slice(0, unitCutoff.unitsIndex).join(" ")),
    units: Number(tokens[unitCutoff.unitsIndex]),
    pre_requisites: extractIncompletePreRequisites(tokens.slice(unitCutoff.cutoffIndex + 1).join(" ")),
  };
}

function findUnitCutoffPair(tokens) {
  for (let index = tokens.length - 1; index > 0; index -= 1) {
    if (isCutoffToken(tokens[index]) && /^\d+$/.test(tokens[index - 1])) {
      return {
        unitsIndex: index - 1,
        cutoffIndex: index,
      };
    }
  }

  return null;
}

function findFirstUnitCutoffPair(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    if (/^\d+$/.test(tokens[index - 1]) && /^\d\.\d$/.test(tokens[index])) {
      return {
        unitsIndex: index - 1,
        cutoffIndex: index,
      };
    }
  }

  return null;
}

function isStatusToken(token) {
  return /^(Enrolled|Passed|Failed|Credited|Taken)$/i.test(token);
}

function isGradeToken(token) {
  return /^\d(?:\.\d)?$/.test(token) || /^(INC|DRP|IP)$/i.test(token);
}

function isCutoffToken(token) {
  return /^\d(?:\.\d)?$/.test(token);
}

function isStandaloneCourseCode(line) {
  const code = cleanText(line);

  return isLikelyCourseCode(code)
    && /(?:\d|(?:^|\s)[IVX]+$)/.test(code);
}

function extractPreRequisites(rawTail) {
  const tailParts = /\s{2,}/.test(rawTail.trim())
    ? rawTail.split(/\s{2,}/).map(cleanText).filter(Boolean)
    : rawTail.split(/\s+/).map(cleanText).filter(Boolean);

  const preRequisites = tailParts.length > 2
    ? tailParts.slice(0, -2).join(" ")
    : "";

  return cleanText(preRequisites);
}

function extractIncompletePreRequisites(rawTail) {
  const tokens = cleanText(rawTail).split(/\s+/).filter(Boolean);

  if (tokens.length && isStatusToken(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  if (tokens.length && /^\d(?:\.\d)?$/.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  return cleanText(tokens.join(" "));
}

function isLikelyCourseCode(code) {
  const tokens = code.split(/\s+/).filter(Boolean);

  if (code.length > 32 || !tokens.length || tokens.length > 4) {
    return false;
  }

  if (!/^[A-Za-z][A-Za-z0-9./-]*$/.test(tokens[0])) {
    return false;
  }

  if (tokens.slice(1).some((token) => !/^[A-Za-z0-9./-]+$/.test(token))) {
    return false;
  }

  if (tokens.length === 1) {
    return /\d/.test(tokens[0]) || /^[A-Z][A-Z0-9./-]{1,15}$/.test(tokens[0]);
  }

  if (isAlphaCode(tokens)) {
    return true;
  }

  const last = tokens[tokens.length - 1];
  const middle = tokens.slice(1, -1);

  return isNumericCodeSuffix(last) || isRomanCodeSuffix(last)
    ? middle.every((token) => !/\d/.test(token))
    : false;
}

function chooseBestCourseCandidate(candidates) {
  if (!candidates.length) {
    return null;
  }

  const romanCandidate = [...candidates]
    .reverse()
    .find((candidate) => {
      const tokens = candidate.code.split(/\s+/);
      return tokens.length > 1 && isRomanCodeSuffix(tokens[tokens.length - 1]);
    });

  if (romanCandidate) {
    return romanCandidate;
  }

  const numberedCandidate = candidates.find((candidate) => {
    const tokens = candidate.code.split(/\s+/);
    return tokens.length > 1 && isNumericCodeSuffix(tokens[tokens.length - 1]);
  });

  if (numberedCandidate) {
    return numberedCandidate;
  }

  const alphaCandidate = [...candidates]
    .reverse()
    .find((candidate) => isAlphaCode(candidate.code.split(/\s+/)));

  if (alphaCandidate) {
    return alphaCandidate;
  }

  const singleNumberedCandidate = candidates.find((candidate) => /\d/.test(candidate.code));

  return singleNumberedCandidate || candidates[0];
}

function isAlphaCode(tokens) {
  return tokens.length === 2
    && tokens.every((token) => /^[A-Z]{2,8}$/.test(token));
}

function isNumericCodeSuffix(token) {
  return /^\d+[A-Za-z]?$/.test(token);
}

function isRomanCodeSuffix(token) {
  return /^[IVX]+$/.test(token);
}

function shouldAppendDescription(line) {
  if (!line || isNoiseLine(line)) {
    return false;
  }

  return !parseYearHeading(line)
    && !parseSemesterHeading(line)
    && !parseCourseLine(line)
    && !/\b(Enrolled|Passed|Failed)\b/i.test(line);
}

function parseYearHeading(line) {
  const match = cleanText(line).match(/^(\d(?:st|nd|rd|th))\s*Year$/i);
  return match ? `${match[1]} Year` : "";
}

function parseSemesterHeading(line) {
  const cleaned = cleanText(line);
  const match = cleaned.match(/^(\d(?:st|nd|rd|th))\s*Semester\b/i);

  if (match) {
    return `${match[1]} Semester`;
  }

  return /^Summer\b/i.test(cleaned) ? "Summer" : "";
}

function parseCurriculum(text, sourceName = "") {
  const curriculumName = getCurriculumName(text, sourceName);
  const totalUnitsRequired = getRequiredUnits(text);
  const groups = [];
  let currentYear = "";
  let currentTerm = null;
  let lastCourse = null;
  let pendingCourseCode = "";
  let pendingPartialCourse = null;

  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\u0000/g, "").replace(/\t/g, "    "))
    .filter((line) => line.trim());

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    const yearHeading = parseYearHeading(trimmed);
    const semesterHeading = parseSemesterHeading(trimmed);

    if (yearHeading) {
      pendingCourseCode = "";
      pendingPartialCourse = null;
      currentYear = yearHeading;
      currentTerm = null;
      lastCourse = null;
      continue;
    }

    if (semesterHeading) {
      pendingCourseCode = "";
      pendingPartialCourse = null;
      currentTerm = {
        year: currentYear,
        semester: semesterHeading,
        courses: [],
      };
      groups.push(currentTerm);
      lastCourse = null;
      continue;
    }

    if (!currentTerm || isNoiseLine(trimmed)) {
      pendingCourseCode = "";
      pendingPartialCourse = null;
      continue;
    }

    if (pendingPartialCourse) {
      const completedCourse = parseCourseTailLine(line, pendingPartialCourse);

      if (completedCourse) {
        currentTerm.courses.push(completedCourse);
        lastCourse = completedCourse;
        pendingPartialCourse = null;
        continue;
      }

      if (lastCourse) {
        lastCourse.description = cleanText(`${lastCourse.description} ${pendingPartialCourse.description}`);
      }

      pendingPartialCourse = null;
    }

    if (pendingCourseCode) {
      const splitCourse = parseCourseDetailLine(line, pendingCourseCode);

      if (splitCourse) {
        currentTerm.courses.push(splitCourse);
        lastCourse = splitCourse;
        pendingCourseCode = "";
        continue;
      }

      if (lastCourse && shouldAppendDescription(pendingCourseCode)) {
        lastCourse.description = cleanText(`${lastCourse.description} ${pendingCourseCode}`);
      }

      pendingCourseCode = "";
    }

    const course = parseCourseLine(line);
    if (course) {
      currentTerm.courses.push(course);
      lastCourse = course;
      continue;
    }

    if (isStandaloneCourseCode(trimmed)) {
      pendingCourseCode = cleanText(trimmed);
      continue;
    }

    const partialCourse = parseCourseStartLine(line);
    if (partialCourse) {
      pendingPartialCourse = partialCourse;
      continue;
    }

    if (lastCourse && shouldAppendDescription(trimmed)) {
      lastCourse.description = cleanText(`${lastCourse.description} ${trimmed}`);
    }
  }

  return {
    metadata: {
      curriculum: curriculumName,
      total_units_required: totalUnitsRequired,
      scraping_date: formatDate(),
      filename: `${curriculumName}.json`,
    },
    curriculum: repairMisassignedWrappedDescriptions(groups.filter((group) => group.courses.length > 0)),
  };
}

function repairMisassignedWrappedDescriptions(groups) {
  repairCourseSequence(groups.flatMap((group) => group.courses));

  for (const group of groups) {
    repairCourseSequence(group.courses);

    for (let index = 1; index < group.courses.length; index += 1) {
      const previous = group.courses[index - 1];
      const current = group.courses[index];

      if (!isLikelyDescriptionFragment(current.description)) {
        continue;
      }

      const words = previous.description.split(/\s+/).filter(Boolean);
      if (words.length < 7) {
        continue;
      }

      const movedWords = words.slice(-2);
      const movedText = movedWords.join(" ");
      if (!/[A-Z]/.test(movedText) || !/[/-]/.test(movedText)) {
        continue;
      }

      previous.description = cleanText(words.slice(0, -2).join(" "));
      current.description = cleanText(`${movedText} ${current.description}`);
    }
  }

  return groups;
}

function repairCourseSequence(courses) {
  repairEmptyCourseDescriptions(courses);
  repairKnownShiftedDescriptions(courses);
  repairChainedShiftedDescriptions(courses);
  repairKnownShiftedDescriptions(courses);
}

function repairChainedShiftedDescriptions(courses) {
  for (let index = 0; index < courses.length - 1; index += 1) {
    const current = courses[index];
    const next = courses[index + 1];
    const splitIndex = findShiftedNextDescriptionIndex(current.description, next);

    if (splitIndex <= 0) {
      continue;
    }

    const currentPart = cleanText(current.description.slice(0, splitIndex));
    const nextPart = cleanText(current.description.slice(splitIndex));

    current.description = currentPart;
    next.description = cleanText(`${nextPart} ${next.description}`);
  }
}

function findShiftedNextDescriptionIndex(description, nextCourse) {
  const text = cleanText(description);
  if (!text || !nextCourse) {
    return -1;
  }

  const words = text.split(/\s+/);
  if (words.length < 3) {
    return -1;
  }

  const explicitStart = findExplicitNextStart(text, nextCourse.code);
  if (explicitStart > 0) {
    return explicitStart;
  }

  if (isLikelyDescriptionFragment(words[0])) {
    const titleCaseIndex = words.findIndex((word, index) => index > 0 && isTitleCaseWord(word));
    if (titleCaseIndex > 0) {
      return indexOfWord(text, titleCaseIndex);
    }
  }

  const allCapsStart = findAllCapsTitleStart(words);
  if (allCapsStart > 0) {
    return indexOfWord(text, allCapsStart);
  }

  return -1;
}

function findExplicitNextStart(description, code) {
  const starts = getLikelyDescriptionStarts(code);
  const match = starts
    .map((start) => description.toLowerCase().indexOf(start.toLowerCase()))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];

  return Number.isInteger(match) ? match : -1;
}

function findAllCapsTitleStart(words) {
  for (let index = 1; index < words.length - 1; index += 1) {
    if (isAllCapsWord(words[index]) && isAllCapsWord(words[index + 1]) && hasLowercaseBefore(words, index)) {
      return index;
    }
  }

  return -1;
}

function hasLowercaseBefore(words, endIndex) {
  return words.slice(0, endIndex).some((word) => /[a-z]/.test(word));
}

function isTitleCaseWord(word) {
  return /^[A-Z][a-z]+/.test(word);
}

function isAllCapsWord(word) {
  const letters = word.match(/[A-Za-z]/g) || [];
  if (!letters.length) {
    return false;
  }

  const upper = word.match(/[A-Z]/g) || [];
  return upper.length / letters.length > 0.75;
}

function indexOfWord(text, wordIndex) {
  const matches = [...text.matchAll(/\S+/g)];
  return matches[wordIndex]?.index ?? -1;
}

function repairEmptyCourseDescriptions(courses) {
  for (let index = 1; index < courses.length; index += 1) {
    const previous = courses[index - 1];
    const current = courses[index];

    if (current.description || !previous.description) {
      continue;
    }

    const movedText = takeTrailingDescriptionForCode(previous.description, current.code);
    if (!movedText) {
      continue;
    }

    previous.description = cleanText(previous.description.slice(0, -movedText.length));
    current.description = cleanText(movedText);
  }
}

function repairKnownShiftedDescriptions(courses) {
  for (let index = 1; index < courses.length; index += 1) {
    const previous = courses[index - 1];
    const current = courses[index];

    if (!previous.description || !current.description) {
      continue;
    }

    const movedText = takeTrailingDescriptionForCode(previous.description, current.code);
    if (!movedText || current.description.startsWith(movedText)) {
      continue;
    }

    previous.description = cleanText(previous.description.slice(0, -movedText.length));
    current.description = cleanText(`${movedText} ${current.description}`);
  }
}

function takeTrailingDescriptionForCode(description, code) {
  const starts = getLikelyDescriptionStarts(code);
  const bestStart = starts
    .map((start) => ({
      index: description.toLowerCase().lastIndexOf(start.toLowerCase()),
      start,
    }))
    .filter((candidate) => candidate.index > 0)
    .sort((a, b) => b.index - a.index)[0];

  return bestStart ? cleanText(description.slice(bestStart.index)) : "";
}

function getLikelyDescriptionStarts(code) {
  const normalized = code.toUpperCase();

  if (/^(PATHFIT|PE)\b/.test(normalized)) {
    return [
      "Physical Act.",
      "Physical Act",
      "Physical Activities",
      "PHYSICAL ACTIVITIES",
    ];
  }

  if (/^NSTP\b/.test(normalized)) {
    return [
      "CIVIC WELFARE",
      "CWTS/ROTC",
      "Reserved Officer",
    ];
  }

  if (/^GE\s*4\b/.test(normalized)) {
    return [
      "PURPOSIVE COMMUNICATION",
    ];
  }

  if (/^PROPEC\b/.test(normalized)) {
    return [
      "Building and Enhancing",
    ];
  }

  if (/^PROFED\b/.test(normalized)) {
    return [
      "THE CHILD",
      "The Teaching",
      "The Teacher",
    ];
  }

  if (/^ECE\b/.test(normalized)) {
    return [
      "Content and Pedagogy",
      "Family and School",
      "Creative Arts",
    ];
  }

  if (/^COGNATES\b/.test(normalized)) {
    return [
      "Understanding and Human",
    ];
  }

  if (/^PROFADV\b/.test(normalized)) {
    return [
      "Human Services",
      "Mental Health",
    ];
  }

  if (/^LEA\b/.test(normalized)) {
    return [
      "Law Enforcement",
    ];
  }

  if (/^CDI\b/.test(normalized)) {
    return [
      "Technical English",
    ];
  }

  return [];
}

function isLikelyDescriptionFragment(description) {
  const cleaned = cleanText(description);
  const words = cleaned.split(/\s+/).filter(Boolean);

  if (!cleaned || words.length > 2 || cleaned.length > 28) {
    return false;
  }

  const letters = cleaned.match(/[A-Za-z]/g) || [];
  const uppercase = cleaned.match(/[A-Z]/g) || [];

  return letters.length > 0 && uppercase.length / letters.length > 0.75;
}

function renderJson(data) {
  latestJson = data;
  const output = JSON.stringify(data, null, 2);
  const courses = data.curriculum.flatMap((group) => group.courses);

  jsonOutput.textContent = output;
  courseCount.textContent = courses.length;
  unitCount.textContent = courses.reduce((sum, course) => sum + course.units, 0);
  termCount.textContent = data.curriculum.length;
  copyButton.disabled = false;
  downloadButton.disabled = false;
}

function showError(message) {
  setStatus("Needs review");
  jsonOutput.textContent = message;
  copyButton.disabled = true;
  downloadButton.disabled = true;
}

async function extractPdfText(file) {
  const pdfjsLib = await ensurePdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows = [];
    const charWidths = content.items
      .filter((item) => item.str.trim() && item.width)
      .map((item) => item.width / item.str.length)
      .filter((width) => Number.isFinite(width) && width > 0);
    const charWidth = median(charWidths) || 4.2;
    const pageMinX = Math.min(...content.items.map((item) => item.transform[4]));

    for (const item of content.items) {
      const [, , , , x, y] = item.transform;
      const row = findTextRow(rows, y);
      row.items.push({ x, text: item.str });
    }

    const pageLines = rows
      .sort((a, b) => b.y - a.y)
      .map((row) => buildPositionedLine(row.items, pageMinX, charWidth))
      .join("\n");

    pages.push(pageLines);
  }

  return pages.join("\n");
}

function findTextRow(rows, y) {
  const tolerance = 1.1;
  const row = rows.find((candidate) => Math.abs(candidate.y - y) <= tolerance);

  if (row) {
    row.y = (row.y * row.items.length + y) / (row.items.length + 1);
    return row;
  }

  const newRow = { y, items: [] };
  rows.push(newRow);
  return newRow;
}

function buildPositionedLine(row, minX, charWidth) {
  const cells = row
    .filter((item) => item.text)
    .sort((a, b) => a.x - b.x);
  let line = "";

  for (const item of cells) {
    const targetIndex = Math.max(0, Math.round((item.x - minX) / charWidth));
    if (targetIndex > line.length) {
      line += " ".repeat(targetIndex - line.length);
    } else if (line && !line.endsWith(" ")) {
      line += " ";
    }

    line += item.text;
  }

  return line.trimEnd();
}

function median(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function handleFile(file) {
  if (!file) {
    return;
  }

  if (file.type !== "application/pdf") {
    showError("Please choose a PDF file.");
    return;
  }

  try {
    uploadedCurriculumName = file.name;
    setStatus("Reading PDF");
    rawText.value = await extractPdfText(file);
    setStatus("Ready");
  } catch (error) {
    showError(`Could not read PDF: ${error.message}`);
  }
}

extractButton.addEventListener("click", () => {
  const text = rawText.value.trim();

  if (!text) {
    showError("Add PDF text before extracting.");
    return;
  }

  const data = parseCurriculum(text, uploadedCurriculumName);
  renderJson(data);
  setStatus(data.curriculum.length ? "Extracted" : "No courses found");
});

clearButton.addEventListener("click", () => {
  rawText.value = "";
  uploadedCurriculumName = "";
  latestJson = null;
  jsonOutput.textContent = "";
  courseCount.textContent = "0";
  unitCount.textContent = "0";
  termCount.textContent = "0";
  copyButton.disabled = true;
  downloadButton.disabled = true;
  setStatus("Idle");
});

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

loadSampleButton.addEventListener("click", () => {
  rawText.value = sampleText.innerHTML.trim();
  uploadedCurriculumName = "";
  setStatus("Sample loaded");
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
