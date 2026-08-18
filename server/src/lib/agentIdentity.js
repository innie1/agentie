const PROFILES = [
  { test: /(?:outbound|prospect|lead generation|lead gen|cold email|sales development|sdr\b|bdr\b)/i, name: "Outbound Sales", tag: "Outbound Sales" },
  { test: /(?:sales|pipeline|closing|deals?|crm)/i, name: "Sales Representative", tag: "Sales" },
  { test: /(?:customer support|customer service|help ?desk|support tickets?|zendesk)/i, name: "Customer Support", tag: "Customer Support" },
  { test: /(?:market research|competitive research|research analyst|research)/i, name: "Research Analyst", tag: "Market Research" },
  { test: /(?:software|developer|engineering|programming|coding|code review|bug fix|repository|\brepo\b)/i, name: "Software Engineer", tag: "Software Engineering" },
  { test: /(?:content marketing|content strategy|social media|seo|copywriting|brand marketing|marketing)/i, name: "Content Marketing", tag: "Content Marketing" },
  { test: /(?:design|figma|graphic|creative direction|video editing)/i, name: "Creative Designer", tag: "Creative Design" },
  { test: /(?:bookkeep|accounting|accounts payable|accounts receivable|invoice|billing|payroll)/i, name: "Finance Assistant", tag: "Financial Operations" },
  { test: /(?:financial analysis|investment|budget|finance)/i, name: "Financial Analyst", tag: "Financial Analysis" },
  { test: /(?:calendar|scheduling|appointments?)/i, name: "Scheduling Assistant", tag: "Calendar Management" },
  { test: /(?:executive assistant|chief of staff|executive operations)/i, name: "Executive Assistant", tag: "Executive Operations" },
  { test: /(?:operations|workflow|logistics|process improvement)/i, name: "Operations Coordinator", tag: "Business Operations" },
  { test: /(?:recruit|hiring|candidate|talent acquisition)/i, name: "Recruiting Coordinator", tag: "Recruiting" },
  { test: /(?:knowledge base|documentation|notion|wiki)/i, name: "Knowledge Manager", tag: "Knowledge Management" },
  { test: /(?:personal|wellness|habit|family|travel)/i, name: "Personal Assistant", tag: "Personal Operations" },
];

function titleCase(value = "") {
  return String(value)
    .replace(/\b(?:ai|agent|assistant)\b/gi, "")
    .replace(/[^a-zA-Z0-9&/\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 4)
    .map((word) => word.length <= 3 && word === word.toUpperCase() ? word : word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** A stable, job-first identity; tools and generated names never affect it. */
export function deriveAgentIdentity({ role = "", goal = "" } = {}) {
  const text = `${role} ${goal}`.trim();
  const profile = PROFILES.find(({ test }) => test.test(text));
  if (profile) return { ...profile };

  const roleName = titleCase(role);
  if (roleName && !/^general$/i.test(roleName)) return { name: roleName, tag: roleName };
  return { name: "Task Assistant", tag: "Task Management" };
}

export function makeUniqueName(baseName, taken = new Set()) {
  const base = String(baseName || "Task Assistant").trim();
  if (!taken.has(base.toLowerCase())) return base;
  let number = 2;
  while (taken.has(`${base} ${number}`.toLowerCase())) number += 1;
  return `${base} ${number}`;
}
