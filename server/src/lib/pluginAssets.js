// Canonical plugin branding metadata. The frontend can use icon_url directly;
// these are the official Simple Icons assets for the corresponding services.
export const PLUGIN_ASSETS = {
  gmail: { icon_url: "https://cdn.simpleicons.org/gmail", icon_alt: "Gmail" },
  gcal: { icon_url: "https://cdn.simpleicons.org/googlecalendar", icon_alt: "Google Calendar" },
  slack: { icon_url: "https://cdn.simpleicons.org/slack", icon_alt: "Slack" },
  github: { icon_url: "https://cdn.simpleicons.org/github", icon_alt: "GitHub" },
  notion: { icon_url: "https://cdn.simpleicons.org/notion", icon_alt: "Notion" },
  granola: { icon_url: "https://cdn.simpleicons.org/granola", icon_alt: "Granola" },
  outlook: { icon_url: "https://cdn.simpleicons.org/microsoftoutlook", icon_alt: "Microsoft Outlook" },
  discord: { icon_url: "https://cdn.simpleicons.org/discord", icon_alt: "Discord" },
  telegram: { icon_url: "https://cdn.simpleicons.org/telegram", icon_alt: "Telegram" },
  whatsapp: { icon_url: "https://cdn.simpleicons.org/whatsapp", icon_alt: "WhatsApp" },
  zoom: { icon_url: "https://cdn.simpleicons.org/zoom", icon_alt: "Zoom" },
  twilio: { icon_url: "https://cdn.simpleicons.org/twilio", icon_alt: "Twilio" },
  x_twitter: { icon_url: "https://cdn.simpleicons.org/x", icon_alt: "X" },
  linkedin: { icon_url: "https://cdn.simpleicons.org/linkedin", icon_alt: "LinkedIn" },
  youtube: { icon_url: "https://cdn.simpleicons.org/youtube", icon_alt: "YouTube" },
  instagram: { icon_url: "https://cdn.simpleicons.org/instagram", icon_alt: "Instagram" },
  hubspot: { icon_url: "https://cdn.simpleicons.org/hubspot", icon_alt: "HubSpot" },
  canva: { icon_url: "https://cdn.simpleicons.org/canva", icon_alt: "Canva" },
  figma: { icon_url: "https://cdn.simpleicons.org/figma", icon_alt: "Figma" },
  gdrive: { icon_url: "https://cdn.simpleicons.org/googledrive", icon_alt: "Google Drive" },
  linear: { icon_url: "https://cdn.simpleicons.org/linear", icon_alt: "Linear" },
  trello: { icon_url: "https://cdn.simpleicons.org/trello", icon_alt: "Trello" },
  jira: { icon_url: "https://cdn.simpleicons.org/jira", icon_alt: "Jira" },
  airtable: { icon_url: "https://cdn.simpleicons.org/airtable", icon_alt: "Airtable" },
  postgres: { icon_url: "https://cdn.simpleicons.org/postgresql", icon_alt: "PostgreSQL" },
  stripe: { icon_url: "https://cdn.simpleicons.org/stripe", icon_alt: "Stripe" },
  shopify: { icon_url: "https://cdn.simpleicons.org/shopify", icon_alt: "Shopify" },
  aws: { icon_url: "https://cdn.simpleicons.org/amazonaws", icon_alt: "AWS" },
  agentmail: { icon_url: "https://cdn.simpleicons.org/maildotru", icon_alt: "AgentMail" },
};

export function withPluginAsset(plugin) {
  const asset = PLUGIN_ASSETS[plugin.id];
  return asset ? { ...plugin, ...asset } : plugin;
}