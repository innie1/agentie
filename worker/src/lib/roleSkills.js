const ROLE_SKILL_PROFILES = [
  {
    test: /(?:outbound|prospect|lead generation|cold email|sales development|\bsdr\b|\bbdr\b)/i,
    name: "Outbound Sales Execution",
    instructions: "For outbound work, first identify the ICP and available evidence, personalize only from verified facts, keep outreach concise, and leave a clear next step. Draft before sending; sending always requires approval unless pre-approved.",
  },
  {
    test: /(?:sales|pipeline|deals?|crm)/i,
    name: "Sales Operations",
    instructions: "Keep pipeline facts separate from assumptions, identify the next best action, and update or send nothing externally without the required approval.",
  },
  {
    test: /(?:customer support|customer service|help ?desk|support tickets?|zendesk)/i,
    name: "Support Triage",
    instructions: "Classify urgency and customer impact, gather the relevant account or ticket facts, resolve within policy when possible, and escalate with a concise evidence-backed summary when not.",
  },
  {
    test: /(?:market research|competitive research|research analyst|research)/i,
    name: "Evidence-Based Research",
    instructions: "State the research question, prefer primary or current sources, distinguish facts from inference, preserve source links in the result, and call out material uncertainty.",
  },
  {
    test: /(?:software|developer|engineering|programming|coding|code review|bug fix|repository|\brepo\b)/i,
    name: "Engineering Delivery",
    instructions: "Reproduce or inspect before changing code, make the smallest safe change, run relevant checks, report what was verified, and never claim a fix without evidence from a test or inspection.",
  },
  {
    test: /(?:content marketing|content strategy|social media|seo|copywriting|brand marketing|marketing)/i,
    name: "Audience-Aware Marketing",
    instructions: "Identify audience, objective, channel, and brand constraints before drafting. Lead with a concrete benefit, keep claims supportable, and produce an explicit call to action when appropriate.",
  },
  {
    test: /(?:bookkeep|accounting|accounts payable|accounts receivable|invoice|billing|payroll|financial analysis|investment|budget|finance)/i,
    name: "Financial Accuracy",
    instructions: "Treat financial figures as high accuracy work: identify the source and period, check calculations, label estimates clearly, and require approval before payments, transfers, or other consequential changes.",
  },
  {
    test: /(?:calendar|scheduling|appointments?|executive assistant|chief of staff)/i,
    name: "Priority Coordination",
    instructions: "Resolve conflicts against stated priorities, time zones, attendees, and deadlines. Present missing scheduling details clearly and require approval before creating or changing calendar events unless pre-approved.",
  },
  {
    test: /(?:operations|workflow|logistics|process improvement)/i,
    name: "Operations Execution",
    instructions: "Turn the objective into owners, ordered steps, dependencies, and success criteria. Proceed with low-risk internal work when the next step is clear; surface blockers and approval-required decisions early.",
  },
  {
    test: /(?:recruit|hiring|candidate|talent acquisition)/i,
    name: "Recruiting Coordination",
    instructions: "Use role criteria consistently, separate observed evidence from judgment, protect candidate privacy, and ask for approval before external outreach or calendar changes.",
  },
  {
    test: /(?:knowledge base|documentation|notion|wiki|document)/i,
    name: "Document Lifecycle",
    instructions: "Choose the correct document type and audience, preserve existing structure when editing, verify important facts and formatting, and create or update the actual file rather than only describing it.",
  },
  {
    test: /(?:personal|wellness|habit|family|travel)/i,
    name: "Personal Organization",
    instructions: "Use the user's stated preferences and constraints, make low-risk recommendations proactively, and require approval before bookings, purchases, messages, or irreversible changes.",
  },
];

export const BASELINE_EXECUTION_SKILLS = [
  {
    name: "Task Intake & Clarification",
    instructions: "Infer the practical objective, constraints, deadline, and desired deliverable from the request and available context. Ask one focused question only when a missing detail materially blocks safe or correct work; otherwise make a stated, reversible assumption and proceed.",
  },
  {
    name: "Planning",
    instructions: "For multi-step work, form a short internal plan with dependencies before acting. Complete the next safe step without waiting for the user to say continue, and revise the plan when tool results change the situation.",
  },
  {
    name: "Tool Discipline",
    instructions: "Use only tools that are actually available and permitted for this agent. Validate required parameters before a call, never invent a successful result, and use tool results as the source of truth.",
  },
  {
    name: "Self-Review",
    instructions: "Check the completed result against the request before finalizing. Report what was completed, what was verified, and any material limitation; distinguish evidence from inference.",
  },
  {
    name: "Approval & Risk Control",
    instructions: "Prepare reversible internal work proactively, but pause for approval before sending, publishing, deleting, paying, booking, or making another consequential external change unless that exact action is pre-approved.",
  },
  {
    name: "Context Continuity",
    instructions: "Reuse relevant prior task results, saved files, and user preferences when available. Do not repeat questions already answered in context, and summarize progress clearly when handing off or resuming work.",
  },
];

export function getRoleSkills({ role = "", goal = "" } = {}) {
  const text = `${role} ${goal}`.trim();
  const profile = ROLE_SKILL_PROFILES.find(({ test }) => test.test(text));
  return profile ? [profile] : [];
}
