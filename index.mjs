function createCopilotPlugin(client, { providerId, isEnterprise }) {
  const CLIENT_ID = "Iv1.b507a08c87ecfe98";
  const HEADERS = {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.99.3",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
  };

  function normalizeDomain(url) {
    return url
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
  }

  function getUrls(domain) {
    return {
      DEVICE_CODE_URL: `https://${domain}/login/device/code`,
      ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
      COPILOT_API_KEY_URL: `https://api.${domain}/copilot_internal/v2/token`,
    };
  }

  return {
    auth: {
      provider: providerId,
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

        // For enterprise, set baseURL dynamically based on enterpriseUrl in auth data
        const enterpriseUrl = info.enterpriseUrl;
        const baseURL = enterpriseUrl
          ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}`
          : undefined;

        return {
          ...(baseURL && { baseURL }),
          apiKey: "",
          async fetch(input, init) {
            const info = await getAuth();
            if (info.type !== "oauth") return {};
            if (!info.access || info.expires < Date.now()) {
              const domain = info.enterpriseUrl
                ? normalizeDomain(info.enterpriseUrl)
                : "github.com";
              const urls = getUrls(domain);

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
                  ...(info.enterpriseUrl && { enterpriseUrl: info.enterpriseUrl }),
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
      methods: isEnterprise
        ? [
            {
              type: "custom",
              label: "Login with GitHub Enterprise",
              prompts: [
                {
                  key: "enterpriseUrl",
                  message: "Enter your GitHub Enterprise URL or domain",
                  placeholder: "github.company.com or https://github.company.com",
                  validate: (value) => {
                    if (!value) return "URL or domain is required";
                    try {
                      const url = value.includes("://")
                        ? new URL(value)
                        : new URL(`https://${value}`);
                      if (!url.hostname)
                        return "Please enter a valid URL or domain";
                      return undefined;
                    } catch {
                      return "Please enter a valid URL (e.g., github.company.com)";
                    }
                  },
                },
              ],
              async authorize(inputs) {
                const enterpriseUrl = inputs.enterpriseUrl;
                const domain = normalizeDomain(enterpriseUrl);
                const urls = getUrls(domain);

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

                if (!deviceResponse.ok) {
                  return { type: "failed" };
                }

                const deviceData = await deviceResponse.json();

                // Display URL and code for user
                console.log(`Go to: ${deviceData.verification_uri}`);
                console.log(`Enter code: ${deviceData.user_code}`);

                // Poll for authorization
                while (true) {
                  await new Promise((resolve) =>
                    setTimeout(resolve, (deviceData.interval || 5) * 1000),
                  );

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
                      auth_type: "oauth",
                      refresh: data.access_token,
                      access: "",
                      expires: 0,
                      enterpriseUrl: domain,
                    };
                  }

                  if (data.error === "authorization_pending") {
                    continue;
                  }

                  if (data.error) return { type: "failed" };
                }
              },
            },
          ]
        : [
            {
              type: "oauth",
              label: "Login with GitHub",
              authorize: async () => {
                const urls = getUrls("github.com");

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

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function CopilotAuthPlugin({ client }) {
  return createCopilotPlugin(client, {
    providerId: "github-copilot",
    isEnterprise: false,
  });
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function CopilotEnterpriseAuthPlugin({ client }) {
  return createCopilotPlugin(client, {
    providerId: "github-copilot-enterprise",
    isEnterprise: true,
  });
}
