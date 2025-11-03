/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function CopilotAuthPlugin({ client }) {
  const CLIENT_ID = "Iv1.b507a08c87ecfe98";
  const HEADERS = {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.99.3",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
  };

  /**
   * Normalizes a domain by removing protocol and trailing slashes
   */
  function normalizeDomain(url) {
    return url
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
  }

  /**
   * Gets the base URL from auth data, provider config, or defaults to github.com
   * Priority: auth data > config > github.com
   */
  async function getBaseUrl(providerId, authInfo) {
    try {
      // First check auth data (set by core during authentication)
      if (authInfo && authInfo.enterpriseUrl) {
        return normalizeDomain(authInfo.enterpriseUrl);
      }

      // Then check config
      const config = await client.config.get();
      const providerConfig = config?.provider?.[providerId];
      const configUrl = providerConfig?.options?.enterpriseUrl;

      return configUrl ? normalizeDomain(configUrl) : "github.com";
    } catch {
      return "github.com";
    }
  }

  /**
   * Constructs URLs based on the base URL (github.com or enterprise)
   */
  async function getUrls(providerId, authInfo) {
    const baseUrl = await getBaseUrl(providerId, authInfo);

    return {
      DEVICE_CODE_URL: `https://${baseUrl}/login/device/code`,
      ACCESS_TOKEN_URL: `https://${baseUrl}/login/oauth/access_token`,
      COPILOT_API_KEY_URL: `https://api.${baseUrl}/copilot_internal/v2/token`,
    };
  }

  return {
    auth: {
      provider: "github-copilot",
      loader: async (getAuth, provider) => {
        let info = await getAuth();
        if (!info || info.type !== "oauth") return {};

        if (provider && provider.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
            };
          }
        }

        return {
          apiKey: "",
          async fetch(input, init) {
            const info = await getAuth();
            if (info.type !== "oauth") return {};
            if (!info.access || info.expires < Date.now()) {
              const urls = await getUrls(provider.id, info);
              const response = await fetch(urls.COPILOT_API_KEY_URL, {
                headers: {
                  Accept: "application/json",
                  Authorization: `Bearer ${info.refresh}`,
                  ...HEADERS,
                },
              });

              if (!response.ok) return;

              const tokenData = await response.json();

              await client.auth.set({
                path: {
                  id: provider.id,
                },
                body: {
                  type: "oauth",
                  refresh: info.refresh,
                  access: tokenData.token,
                  expires: tokenData.expires_at * 1000,
                },
              });
              info.access = tokenData.token;
            }
            let isAgentCall = false;
            let isVisionRequest = false;
            try {
              const body =
                typeof init.body === "string"
                  ? JSON.parse(init.body)
                  : init.body;
              if (body?.messages) {
                isAgentCall = body.messages.some(
                  (msg) => msg.role && ["tool", "assistant"].includes(msg.role),
                );
                isVisionRequest = body.messages.some(
                  (msg) =>
                    Array.isArray(msg.content) &&
                    msg.content.some((part) => part.type === "image_url"),
                );
              }
            } catch {}
            const headers = {
              ...init.headers,
              ...HEADERS,
              Authorization: `Bearer ${info.access}`,
              "Openai-Intent": "conversation-edits",
              "X-Initiator": isAgentCall ? "agent" : "user",
            };
            if (isVisionRequest) {
              headers["Copilot-Vision-Request"] = "true";
            }
            delete headers["x-api-key"];
            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      },
      methods: [
        {
          label: "Login with GitHub",
          type: "oauth",
          authorize: async () => {
            // During authorize, read from config only (no auth data exists yet)
            const urls = await getUrls("github-copilot", null);
            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": "GitHubCopilotChat/0.35.0",
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: "read:user",
              }),
            });
            const deviceData = await deviceResponse.json();
            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto",
              callback: async () => {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": "GitHubCopilotChat/0.35.0",
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type:
                        "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  });

                  if (!response.ok) return { type: "failed" };

                  const data = await response.json();

                  if (data.access_token) {
                    return {
                      type: "success",
                      refresh: data.access_token,
                      access: "",
                      expires: 0,
                    };
                  }

                  if (data.error === "authorization_pending") {
                    await new Promise((resolve) =>
                      setTimeout(resolve, deviceData.interval * 1000),
                    );
                    continue;
                  }

                  if (data.error) return { type: "failed" };

                  await new Promise((resolve) =>
                    setTimeout(resolve, deviceData.interval * 1000),
                  );
                  continue;
                }
              },
            };
          },
        },
      ],
    },
  };
}
