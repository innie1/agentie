// Maps plugin ids to the env vars holding their OAuth app credentials,
// plus how to parse each provider's token response.

function googleProvider() {
  return {
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
      token_type: data.token_type,
    }),
  };
}

export const OAUTH_PROVIDERS = {
  gmail: googleProvider(),
  gcal: googleProvider(),
  google_calendar: googleProvider(),
  gdrive: googleProvider(),
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
      expires_in: data.expires_in ?? null,
      token_type: data.token_type,
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
      refresh_token: data.refresh_token ?? null,
      expires_in: data.expires_in ?? null,
      token_type: data.token_type,
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
      refresh_token: data.refresh_token ?? null,
      expires_in: data.expires_in ?? null,
      token_type: data.token_type,
    }),
    basicAuth: () => ({
      username: process.env.NOTION_CLIENT_ID,
      password: process.env.NOTION_CLIENT_SECRET,
    }),
  },
};
