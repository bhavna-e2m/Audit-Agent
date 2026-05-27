const http = require("http");
const { google } = require("googleapis");
const openModule = require("open");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in env."
  );
  process.exit(1);
}

// A simple local callback server to capture the `code`.
const PORT = Number(process.env.GOOGLE_OAUTH_LOCAL_PORT || 5151);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive"
];

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`OAuth error: ${error}`);
      server.close();
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing ?code=...");
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      "Success. You can close this tab and check your terminal for the refresh token.\n"
    );

    console.log("\n=== Google OAuth Tokens ===");
    console.log("Redirect URI used:", REDIRECT_URI);
    console.log("Scopes:", SCOPES.join(" "));
    console.log("\nREFRESH TOKEN (copy into .env / Vercel):\n");
    console.log(refreshToken || "(No refresh_token returned)");
    console.log("\n==========================\n");

    server.close();
  } catch (e) {
    console.error("Failed to exchange code for tokens:", e?.message || e);
    try {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Token exchange failed. Check terminal.");
    } catch (_) {}
    server.close();
  }
});

server.listen(PORT, () => {
  console.log("Listening on:", REDIRECT_URI);
  console.log("Client ID:", CLIENT_ID);
  console.log("\nIf you get redirect_uri_mismatch, add THIS exact URI in Google Cloud -> OAuth Client -> Authorized redirect URIs:\n");
  console.log(REDIRECT_URI);
  console.log("\nConsent URL (open manually if needed):\n");
  console.log(authUrl);
  console.log("\nOpening consent screen in your browser...\n");
  const openBrowser = typeof openModule === "function" ? openModule : openModule.default;
  Promise.resolve(openBrowser(authUrl)).catch(() => {
    console.log("Open this URL manually:\n", authUrl);
  });
});

