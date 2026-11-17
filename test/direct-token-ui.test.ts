import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderAdminHtml } from "../src/admin/ui.js";
class Element {
  value = "";
  checked = false;
  textContent = "";
  disabled = false;
  open = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  classes = new Set(["hidden"]);
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, force: boolean) => (force ? this.classes.add(name) : this.classes.delete(name)),
  };
  setAttribute = vi.fn();
  addEventListener = vi.fn();
  focus = vi.fn();
  select = vi.fn();
  reset = vi.fn();
  remove = vi.fn();
  onclick?: () => Promise<void> | void;
  onchange?: () => void;
  oninput?: () => void;
  onsubmit?: (event: { preventDefault: () => void }) => Promise<void>;
  replaceChildren(...children: Element[]) {
    this.children = [];
    this.value = "";
    this.append(...children);
  }
  append(...children: Element[]) {
    for (const child of children) {
      this.children.push(child);
      if (this.children.length === 1) this.value = child.value;
    }
  }
  contains(element: Element | undefined): boolean {
    return this.children.some((child) => child === element || child.contains(element));
  }
  querySelectorAll(): Element[] {
    return [];
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
const client = (clientId = "efa1f375-d761-44fa-81a3-556a97e641e6") => ({
  clientId,
  clientType: "PUBLIC",
  redirectUris: [],
  requiredResourceAccess: [{ resourceAppId: "55555555-5555-4555-8555-555555555555", scopes: ["access_as_user"] }],
});
const user = (sub = "user") => ({ sub, name: "User", preferred_username: "user@example.com", groups: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(initial?: { clients: Promise<unknown> }) {
  const html = renderAdminHtml("tenant", "http://localhost", "http://localhost/logout");
  const script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("Admin script not found");
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  get("scenario").value = "NORMAL";
  get("mode").value = "CONTINUOUS";
  const server = { clients: [client()], users: [user()] };
  const request = vi.fn<
    (
      url: string,
      options?: {
        method?: string;
        body?: string;
      },
    ) => Promise<unknown>
  >();
  const readServer = async (url: string) => {
    if (url === "/__mock/api/clients") return structuredClone(server.clients);
    if (url === "/__mock/api/users") return structuredClone(server.users);
    if (url === "/__mock/api/resources") return [];
    if (url === "/__mock/api/access-log") return [];
    if (url === "/__mock/api/scenario") return { scenario: "NORMAL", status: "NORMAL", triggeredCount: 0 };
    throw new Error("Unexpected request: " + url);
  };
  let firstClients = initial?.clients;
  request.mockImplementation((url) => {
    if (url === "/__mock/api/clients" && firstClients) {
      const pending = firstClients;
      firstClients = undefined;
      return pending;
    }
    return readServer(url);
  });
  const refresh = vi.fn(async () => {});
  const writeText = vi.fn<(value: string) => Promise<void>>(async () => {});
  const copyFallback = vi.fn<(value: string) => void>();
  const sandbox = {
    Error,
    document: {
      getElementById: get,
      createElement: () => new Element(),
      querySelectorAll: () => [],
      activeElement: new Element(),
      body: new Element(),
    },
    fetch: async (
      url: string,
      options?: {
        method?: string;
        body?: string;
      },
    ) => ({
      ok: true,
      text: async () => JSON.stringify(await request(url, options)),
    }),
    navigator: { clipboard: { writeText } },
    refreshSpy: refresh,
    copyFallbackSpy: copyFallback,
    localStorage: { getItem: () => null, setItem: vi.fn() },
    confirm: () => true,
    setTimeout: () => 1,
    clearTimeout: vi.fn(),
  };
  runInNewContext(script, sandbox);
  if (initial) await vi.waitFor(() => expect(firstClients).toBeUndefined());
  else await vi.waitFor(() => expect(get("issueToken").disabled).toBe(false));
  runInNewContext("refresh = refreshSpy; copyFallback = copyFallbackSpy;", sandbox);
  request.mockClear();
  const populate = () => {
    runInNewContext(
      `setTokenChoices('client',[{clientId:'efa1f375-d761-44fa-81a3-556a97e641e6',requiredResourceAccess:[{resourceAppId:'55555555-5555-4555-8555-555555555555',scopes:['access_as_user']}]}]);setTokenChoices('user',[{sub:'user',name:'User'}]);`,
      sandbox,
    );
  };
  const submit = () => get("tokenForm").onsubmit!({ preventDefault: vi.fn() });
  const reload = () => runInNewContext("loadTokenChoices()", sandbox) as Promise<void>;
  const load = (kind: "client" | "user") => runInNewContext(kind + "Editor.load()", sandbox) as Promise<void>;
  return {
    get,
    request,
    refresh,
    writeText,
    copyFallback,
    sandbox,
    populate,
    submit,
    reload,
    load,
    server,
    readServer,
  };
}
const result = {
  access_token: "test.jwt.token",
  fault: { scenario: "NO_GROUPS", mode: "LIMITED", remainingBefore: 1, remainingAfter: 0 },
};
describe("direct token Admin UI interactions", () => {
  it("preserves narrowed scopes when candidates are reloaded or permissions grow", async () => {
    const ui = await setup();
    ui.server.clients[0]!.requiredResourceAccess[0]!.scopes.push("write");
    ui.get("tokenScopes").value = "access_as_user";
    await ui.reload();
    expect(ui.get("tokenScopes").value).toBe("access_as_user");
    ui.request.mockResolvedValueOnce(result);
    await ui.submit();
    const payload = JSON.parse(ui.request.mock.calls.find(([url]) => url.endsWith("/tokens"))![1]!.body!);
    expect(payload.scopes).toEqual(["access_as_user"]);
  });
  it("keeps intentionally cleared scopes empty across reloads and disables issuance", async () => {
    const ui = await setup();
    ui.get("tokenScopes").value = "";
    await ui.reload();
    expect(ui.get("tokenScopes").value).toBe("");
    expect(ui.get("issueToken").disabled).toBe(true);
    ui.get("tokenScopes").value = "access_as_user";
    ui.get("tokenScopes").oninput!();
    expect(ui.get("issueToken").disabled).toBe(false);
  });
  it("uses the new permission defaults when the client or API is explicitly changed", async () => {
    const ui = await setup();
    const resourceAppId = "66666666-6666-4666-8666-666666666666";
    const otherClient = {
      ...client("00000000-0000-4000-8000-000000000004"),
      requiredResourceAccess: [{ resourceAppId, scopes: ["other.read"] }],
    };
    ui.server.clients[0]!.requiredResourceAccess.push({ resourceAppId, scopes: ["read", "write"] });
    ui.server.clients.push(otherClient);
    await ui.reload();
    ui.get("tokenScopes").value = "access_as_user";
    ui.get("tokenResource").value = resourceAppId;
    ui.get("tokenResource").onchange!();
    expect(ui.get("tokenScopes").value).toBe("read write");
    ui.get("tokenScopes").value = "read";
    ui.get("tokenClient").value = otherClient.clientId;
    ui.get("tokenClient").onchange!();
    expect(ui.get("tokenScopes").value).toBe("other.read");
  });
  it("round-trips typed redirect URIs and API permissions through the client editor", async () => {
    const ui = await setup();
    const fixture = {
      ...client(),
      emailOptionalClaim: true,
      groupMembershipClaims: "SecurityGroup",
      redirectUris: [
        { type: "spa", uri: "https://spa.example.test/callback" },
        { type: "native", uri: "com.example.app:/callback" },
      ],
      requiredResourceAccess: [
        { resourceAppId: "55555555-5555-4555-8555-555555555555", scopes: ["read", "write"] },
        { resourceAppId: "66666666-6666-4666-8666-666666666666", scopes: ["read"] },
      ],
    };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openClient(fixture)", ui.sandbox);
    expect(ui.get("redirectUris").value).toBe(
      "spa https://spa.example.test/callback\nnative com.example.app:/callback",
    );
    ui.request.mockImplementation((url, options) =>
      options?.method === "PUT" ? Promise.resolve(fixture) : ui.readServer(url),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "PUT")![1]!.body!);
    const expected: Record<string, unknown> = { ...fixture, tokenEndpointAuthMethod: "none" };
    delete expected.clientId;
    expect(body).toEqual(expected);
  });
  it("round-trips API scope lines and a default v1 token version through the resource editor", async () => {
    const ui = await setup();
    const fixture = {
      resourceAppId: "66666666-6666-4666-8666-666666666666",
      identifierUri: "api://example",
      scopes: ["read", "write"],
      requestedAccessTokenVersion: null,
      emailOptionalClaim: true,
      groupMembershipClaims: "None",
    };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openResource(fixture)", ui.sandbox);
    expect(ui.get("resourceScopes").value).toBe("read\nwrite");
    ui.request.mockImplementation((url, options) =>
      options?.method === "PUT" ? Promise.resolve(fixture) : ui.readServer(url),
    );
    await ui.get("resourceForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "PUT")![1]!.body!);
    const expected: Record<string, unknown> = { ...fixture };
    delete expected.resourceAppId;
    expect(body).toEqual(expected);
  });
  it("keeps token user choices available when loading API registrations fails", async () => {
    const ui = await setup();
    ui.request.mockImplementation((url) => {
      if (url === "/__mock/api/resources") throw new Error("API read failed");
      return ui.readServer(url);
    });
    await runInNewContext("resourceEditor.load()", ui.sandbox);
    expect(ui.get("resourceError").textContent).toContain("API read failed");
    expect(ui.get("tokenUser").value).toBe("user");
    expect(ui.get("issueToken").disabled).toBe(false);
  });
  it("selects registered candidates, prevents duplicate submissions and displays/copies the result", async () => {
    const ui = await setup();
    ui.populate();
    expect(ui.get("issueToken").disabled).toBe(false);
    let finish!: (value: unknown) => void;
    ui.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = ui.submit();
    expect(ui.get("issueToken").disabled).toBe(true);
    expect(ui.get("tokenClient").disabled).toBe(true);
    await ui.submit();
    expect(ui.request).toHaveBeenCalledTimes(1);
    expect(ui.request).toHaveBeenCalledWith(
      "/__mock/api/tokens",
      expect.objectContaining({
        body: JSON.stringify({
          clientId: "efa1f375-d761-44fa-81a3-556a97e641e6",
          userId: "user",
          resourceAppId: "55555555-5555-4555-8555-555555555555",
          scopes: ["access_as_user"],
        }),
      }),
    );
    finish(result);
    await pending;
    expect(ui.get("issuedToken").value).toBe(result.access_token);
    expect(ui.get("tokenResult").classes.has("hidden")).toBe(false);
    expect(ui.get("tokenFault").textContent).toContain("NO_GROUPS（残り 1 → 0）");
    expect(ui.refresh).toHaveBeenCalledTimes(1);
    await ui.get("copyToken").onclick!();
    expect(ui.writeText).toHaveBeenCalledWith(result.access_token);
    expect(ui.sandbox.localStorage.setItem).not.toHaveBeenCalled();
  });
  it("clears an earlier result on an error and refreshes scenario state", async () => {
    const ui = await setup();
    ui.populate();
    ui.request.mockResolvedValueOnce(result).mockRejectedValueOnce(new Error("ユーザーが見つかりません"));
    await ui.submit();
    await ui.submit();
    expect(ui.get("issuedToken").value).toBe("");
    expect(ui.get("tokenResult").classes.has("hidden")).toBe(true);
    expect(ui.get("copyToken").disabled).toBe(true);
    expect(ui.get("tokenError").textContent).toBe("ユーザーが見つかりません");
    expect(ui.refresh).toHaveBeenCalledTimes(2);
    expect(ui.get("issueToken").disabled).toBe(false);
  });
  it("leaves the token available for manual copying when both clipboard paths fail", async () => {
    const ui = await setup();
    ui.populate();
    ui.request.mockResolvedValue(result);
    await ui.submit();
    ui.writeText.mockRejectedValue(new Error("denied"));
    ui.copyFallback.mockImplementation(() => {
      throw new Error("denied");
    });
    await ui.get("copyToken").onclick!();
    expect(ui.get("issuedToken").value).toBe(result.access_token);
    expect(ui.get("issuedToken").select).toHaveBeenCalled();
    expect(ui.get("tokenMessage").textContent).toContain("手動でコピー");
  });
  it("disables issuing for empty candidates and supports reloading after an error", async () => {
    const ui = await setup();
    runInNewContext("setTokenChoices('client',[]);setTokenChoices('user',[]);", ui.sandbox);
    expect(ui.get("issueToken").disabled).toBe(true);
    ui.request.mockRejectedValue(new Error("connection failed"));
    await ui.get("refreshTokenChoices").onclick!();
    await vi.waitFor(() => expect(ui.get("tokenChoicesError").textContent).toContain("候補を読み込めませんでした"));
    expect(ui.get("issueToken").disabled).toBe(true);
    ui.request.mockImplementation(async (url) => (url.endsWith("clients") ? [client()] : [user()]));
    await ui.get("refreshTokenChoices").onclick!();
    await vi.waitFor(() => expect(ui.get("issueToken").disabled).toBe(false));
    expect(ui.get("tokenChoicesError").textContent).toBe("");
  });
  it("invalidates the old token when the selected user changes", async () => {
    const ui = await setup();
    ui.populate();
    ui.request.mockResolvedValue(result);
    await ui.submit();
    ui.get("tokenUser").onchange!();
    expect(ui.get("issuedToken").value).toBe("");
    expect(ui.get("copyToken").disabled).toBe(true);
  });
  it("shows the issued token and original subject when candidate updates finish during issuance", async () => {
    const ui = await setup();
    const pending = deferred<unknown>();
    ui.request.mockImplementation((url) => (url.endsWith("tokens") ? pending.promise : ui.readServer(url)));
    const issuing = ui.submit();
    ui.server.clients = [client("new-client")];
    ui.server.users = [user("new-user")];
    await Promise.all([ui.load("client"), ui.load("user")]);
    expect(ui.get("tokenClient").value).toBe("new-client");
    expect(ui.get("tokenUser").value).toBe("new-user");
    pending.resolve(result);
    await issuing;
    expect(ui.get("issuedToken").value).toBe(result.access_token);
    expect(ui.get("tokenSubject").textContent).toBe(
      "発行対象: クライアント efa1f375-d761-44fa-81a3-556a97e641e6 / ユーザー user / API 55555555-5555-4555-8555-555555555555 / スコープ access_as_user",
    );
    expect(ui.get("tokenResult").classes.has("hidden")).toBe(false);
    await ui.get("copyToken").onclick!();
    expect(ui.writeText).toHaveBeenCalledWith(result.access_token);
  });
  it("preserves a completed result across candidate reloads and automatic selection changes", async () => {
    const ui = await setup();
    ui.request.mockResolvedValueOnce(result);
    await ui.submit();
    ui.server.clients = [client("other-client")];
    ui.server.users = [];
    await ui.reload();
    expect(ui.get("issuedToken").value).toBe(result.access_token);
    expect(ui.get("tokenSubject").textContent).toBe(
      "発行対象: クライアント efa1f375-d761-44fa-81a3-556a97e641e6 / ユーザー user / API 55555555-5555-4555-8555-555555555555 / スコープ access_as_user",
    );
    expect(ui.get("issueToken").disabled).toBe(true);
    expect(ui.get("copyToken").disabled).toBe(false);
    await ui.get("copyToken").onclick!();
    expect(ui.writeText).toHaveBeenCalledWith(result.access_token);
  });
  it("shares the initial list generation with a later candidate reload", async () => {
    const first = deferred<unknown>();
    const ui = await setup({ clients: first.promise });
    ui.server.clients = [client("latest-client")];
    await ui.reload();
    first.resolve([client("deleted-client")]);
    await vi.waitFor(() => expect(ui.get("retryClients").disabled).toBe(false));
    // Drain the old fetch/text/JSON continuation before inspecting the snapshot.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.get("tokenClient").value).toBe("latest-client");
    expect(ui.get("clients").children[0]).toBeDefined();
    expect(ui.get("issueToken").disabled).toBe(false);
  });
  it("ignores a stale failed reload after a newer list has succeeded", async () => {
    const ui = await setup();
    const stale = deferred<unknown>();
    ui.request.mockImplementationOnce(() => stale.promise);
    const previous = ui.load("client");
    await vi.waitFor(() => expect(ui.request).toHaveBeenCalledTimes(1));
    ui.server.clients = [client("latest-client")];
    await ui.reload();
    stale.reject(new Error("old failure"));
    await previous;
    expect(ui.get("tokenClient").value).toBe("latest-client");
    expect(ui.get("tokenChoicesError").textContent).toBe("");
    expect(ui.get("issueToken").disabled).toBe(false);
  });
  it.each(["client", "user"] as const)(
    "disables only unavailable %s candidates and recovers through the shared loader",
    async (kind) => {
      const ui = await setup();
      ui.request.mockResolvedValueOnce(result);
      await ui.submit();
      const url = "/__mock/api/" + kind + "s";
      ui.request.mockImplementation(async (path) => {
        if (path === url) throw new Error("connection failed");
        return ui.readServer(path);
      });
      await ui.reload();
      expect(ui.get(kind === "client" ? "tokenClient" : "tokenUser").disabled).toBe(true);
      expect(ui.get(kind === "client" ? "tokenUser" : "tokenClient").disabled).toBe(false);
      expect(ui.get("issueToken").disabled).toBe(true);
      expect(ui.get("tokenChoicesError").textContent).toContain("connection failed");
      expect(ui.get("issuedToken").value).toBe(result.access_token);
      ui.request.mockImplementation(ui.readServer);
      await ui.load(kind);
      expect(ui.get("tokenChoicesError").textContent).toBe("");
      expect(ui.get("issueToken").disabled).toBe(false);
    },
  );
  it.each([
    ["client", "save"],
    ["client", "delete"],
    ["client", "reset"],
    ["user", "save"],
    ["user", "delete"],
    ["user", "reset"],
  ] as const)("keeps the %s candidates current when an older GET finishes after %s", async (kind, action) => {
    const ui = await setup();
    const old = deferred<unknown>();
    const base = "/__mock/api/" + kind + "s";
    const oldItems = kind === "client" ? ui.server.clients : ui.server.users;
    let first = true;
    ui.request.mockImplementation((url, options) => {
      if (url === base && !options?.method && first) {
        first = false;
        return old.promise;
      }
      if (options?.method && url.startsWith(base)) {
        const items = kind === "client" ? ui.server.clients : ui.server.users;
        return Promise.resolve(action === "reset" ? items : items[0]);
      }
      return ui.readServer(url);
    });
    const loading = ui.load(kind);
    await vi.waitFor(() => expect(first).toBe(false));
    if (kind === "client") ui.server.clients = [client("latest-client")];
    else ui.server.users = [user("latest-user")];
    if (action === "reset") {
      await ui.get(kind === "client" ? "resetClients" : "resetUsers").onclick!();
    } else if (action === "save") {
      await (runInNewContext(
        kind +
          "Editor.open('" +
          (kind === "client" ? "efa1f375-d761-44fa-81a3-556a97e641e6" : "user") +
          "');" +
          kind +
          "Editor.save({})",
        ui.sandbox,
      ) as Promise<void>);
    } else {
      const walk = (element: Element): Element[] => [element, ...element.children.flatMap(walk)];
      const button = walk(ui.get(kind + "s")).find((element) => element.textContent === "削除");
      if (!button) throw new Error("Delete button not found");
      await button.onclick!();
    }
    old.resolve(oldItems);
    await loading;
    expect(ui.get(kind === "client" ? "tokenClient" : "tokenUser").value).toBe("latest-" + kind);
    expect(ui.get("tokenChoicesError").textContent).toBe("");
    expect(ui.get("issueToken").disabled).toBe(false);
  });
});
