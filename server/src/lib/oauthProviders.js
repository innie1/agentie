// Maps a plugin_id to the env vars holding its OAuth app credentials,
// plus how to parse each provider's token response (they're not all the same shape).

export const OAUTH_PROVIDERS = {
  gmail: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    tokenBody: (code, redirectUri) => ({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    parseToken: (data) => ({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    }),
  },
  google_calendar: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    tokenBody: (code, redirectUri) => ({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    parseToken: (data) => ({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    }),
  },
  slack: {
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    tokenBody: (code, redirectUri) => ({
      code,
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
    parseToken: (data) => ({
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      expires_in: data.expires_in ?? null, // Slack bot tokens often don't expire
    }),
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    tokenBody: (code, redirectUri) => ({
      code,
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
    parseToken: (data) => ({
      access_token: data.access_token,
      refresh_token: null, // classic GitHub OAuth tokens don't expire/rotate by default
      expires_in: null,
    }),
    tokenHeaders: { Accept: "application/json" },
  },
  notion: {
    clientId: process.env.NOTION_CLIENT_ID,
    clientSecret: process.env.NOTION_CLIENT_SECRET,
    tokenBody: (code, redirectUri) => ({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
    parseToken: (data) => ({
      access_token: data.access_token,
      refresh_token: null,
      expires_in: null,
    }),
    // Notion requires HTTP Basic auth with client_id:client_secret instead of body params
    basicAuth: () => ({
      username: process.env.NOTION_CLIENT_ID,
      password: process.env.NOTION_CLIENT_SECRET,
    }),
  },
};
