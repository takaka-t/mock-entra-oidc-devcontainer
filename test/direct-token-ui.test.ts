import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderAdminHtml } from "../src/admin/ui.js";
import { parseCreateClient, parseUpdateClient } from "../src/clients/validation.js";
import { resourceSchema, updateResourceSchema } from "../src/resources/validation.js";
class Element {
  constructor(
    readonly tagName = "div",
    private readonly onFocus?: (element: Element) => void,
  ) {}
  id = "";
  className = "";
  type = "";
  required = false;
  maxLength = -1;
  willValidate = false;
  validity: Partial<ValidityState> = { valid: true };
  parent: Element | undefined;
  value = "";
  checked = false;
  private text = "";
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.text = value;
  }
  disabled = false;
  open = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  classes = new Set(["hidden"]);
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force: boolean) => (force ? this.classes.add(name) : this.classes.delete(name)),
  };
  attributes = new Map<string, string>();
  setAttribute = vi.fn((name: string, value: string) => {
    this.attributes.set(name, value);
  });
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  scrollIntoView = vi.fn();
  after(element: Element) {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    this.parent.children.splice(index + 1, 0, element);
    element.parent = this.parent;
  }
  addEventListener =
    vi.fn<
      (type: string, listener: (event: { key?: string; target?: Element; preventDefault: () => void }) => void) => void
    >();
  dispatch(type: string, event: { key?: string; target?: Element; preventDefault: () => void }) {
    for (const [name, listener] of this.addEventListener.mock.calls) if (name === type) listener(event);
  }
  focus = vi.fn(() => {
    if (!this.disabled) this.onFocus?.(this);
  });
  select = vi.fn();
  reset = vi.fn();
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }
  onclick?: () => Promise<void> | void;
  onchange?: () => void;
  oninput?: () => void;
  onsubmit?: (event: { preventDefault: () => void }) => Promise<void>;
  replaceChildren(...children: Element[]) {
    this.text = "";
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.value = "";
    this.append(...children);
  }
  append(...children: Element[]) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
      if (this.children.length === 1) this.value = child.value;
    }
  }
  contains(element: Element | undefined): boolean {
    return this.children.some((child) => child === element || child.contains(element));
  }
  querySelectorAll(selector: string): Element[] {
    const matches = (child: Element) =>
      selector
        .split(",")
        .some((tag) =>
          tag === "button[data-edit-id]"
            ? child.tagName === "button" && child.dataset.editId !== undefined
            : tag.startsWith(".")
              ? child.className.split(" ").includes(tag.slice(1))
              : child.tagName === tag,
        );
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): Element | undefined {
    return this.querySelectorAll(selector)[0];
  }
  closest(): Element | undefined {
    return undefined;
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
const resource = (resourceAppId = "55555555-5555-4555-8555-555555555555") => ({
  resourceAppId,
  identifierUri: "api://" + resourceAppId,
  scopes: ["access_as_user", "api.read", "api.write"],
  requestedAccessTokenVersion: 2,
  emailOptionalClaim: false,
  groupMembershipClaims: "None",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(initial?: { clients?: Promise<unknown>; resources?: Promise<unknown> }) {
  const html = renderAdminHtml("tenant", "http://localhost", "http://localhost/logout");
  const script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("Admin script not found");
  const focusState = { activeElement: new Element() };
  const createElement = (tag = "div") =>
    new Element(tag, (element) => {
      focusState.activeElement = element;
    });
  const elements = new Map<string, Element>();
  for (const [, tag, id] of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"/g)) {
    const element = createElement(tag);
    element.id = id!;
    elements.set(id!, element);
  }
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id)!;
  };
  for (const [tag] of html.matchAll(/<[^>]*\bdata-editor-transient="true"[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (id) get(id).dataset.editorTransient = "true";
  }
  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (!id) continue;
    get(id).type = /\btype="([^"]+)"/.exec(tag)?.[1] ?? "text";
    get(id).checked = /\schecked(?:\s|>)/.test(tag);
  }
  for (const [tag] of html.matchAll(/<[a-z]+\b[^>]*\bid="[^"]+"[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(tag)![1]!;
    for (const [, name, value] of tag.matchAll(/\b(aria-[a-z-]+)="([^"]*)"/g)) get(id).setAttribute(name!, value!);
  }
  get("scenario").value = "NORMAL";
  get("mode").value = "CONTINUOUS";
  get("platform").willValidate = true;
  Object.defineProperty(get("platform"), "validity", {
    get: () => ({ valid: !!get("platform").value, valueMissing: !get("platform").value }),
  });
  for (const kind of ["client", "user", "resource"]) {
    const cap = kind[0]!.toUpperCase() + kind.slice(1);
    const formHtml = new RegExp('<form id="' + kind + 'Form"[^>]*>([\\s\\S]*?)<\\/form>').exec(html)![1]!;
    for (const [, id] of formHtml.matchAll(/\bid="([^"]+)"/g)) get(kind + "Form").append(get(id!));
    get(kind + "Editor").append(get("close" + cap), get(kind + "Form"));
  }
  const server = { clients: [client()], users: [user()], resources: [] as ReturnType<typeof resource>[] };
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
    if (url === "/__mock/api/resources") return structuredClone(server.resources);
    if (url === "/__mock/api/access-log") return [];
    if (url === "/__mock/api/scenario") return { scenario: "NORMAL", status: "NORMAL", triggeredCount: 0 };
    throw new Error("Unexpected request: " + url);
  };
  let firstClients = initial?.clients;
  let firstResources = initial?.resources;
  request.mockImplementation((url) => {
    if (url === "/__mock/api/clients" && firstClients) {
      const pending = firstClients;
      firstClients = undefined;
      return pending;
    }
    if (url === "/__mock/api/resources" && firstResources) {
      const pending = firstResources;
      firstResources = undefined;
      return pending;
    }
    return readServer(url);
  });
  const refresh = vi.fn(async () => {});
  const writeText = vi.fn<(value: string) => Promise<void>>(async () => {});
  const copyFallback = vi.fn<(value: string) => void>();
  let timerNow = 0,
    nextTimerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const advanceTime = (duration: number) => {
    const end = timerNow + duration;
    for (;;) {
      const next = [...timers]
        .filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      timerNow = timer.due;
      timer.callback();
    }
    timerNow = end;
  };
  const sandbox = {
    Error,
    document: {
      getElementById: get,
      createElement,
      querySelectorAll: () => [],
      get activeElement() {
        return focusState.activeElement;
      },
      set activeElement(element: Element) {
        focusState.activeElement = element;
      },
      body: createElement(),
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
    crypto: globalThis.crypto,
    refreshSpy: refresh,
    copyFallbackSpy: copyFallback,
    localStorage: { getItem: () => null, setItem: vi.fn() },
    confirm: vi.fn(() => true),
    setTimeout: vi.fn<(callback: () => void, delay: number) => number>((callback, delay) => {
      const id = ++nextTimerId;
      timers.set(id, { due: timerNow + delay, callback });
      return id;
    }),
    clearTimeout: vi.fn<(id: number) => void>((id) => {
      timers.delete(id);
    }),
  };
  runInNewContext(script, sandbox);
  if (initial)
    await vi.waitFor(() => {
      expect(firstClients).toBeUndefined();
      expect(firstResources).toBeUndefined();
    });
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
  const reload = () =>
    runInNewContext("Promise.all([clientEditor.load(), userEditor.load()])", sandbox) as Promise<void>;
  const load = (kind: "client" | "user" | "resource") =>
    runInNewContext(kind + "Editor.load()", sandbox) as Promise<void>;
  const rows = () => get("redirectUris").children;
  const addUri = () => get("addRedirectUri").onclick!();
  const selectPlatform = (type: string) => {
    get("platform").value = type;
    get("platform").onchange!();
  };
  const startClient = async (type = "spa", uri = "http://localhost:3000/callback") => {
    await get("newClient").onclick!();
    selectPlatform(type);
    rows()[0]!.querySelector("input")!.value = uri;
  };
  const openExistingClient = () => {
    const fixture = { ...client(), redirectUris: [{ type: "spa", uri: "https://app.example.test/callback" }] };
    Object.assign(sandbox, { fixture });
    runInNewContext("openClient(fixture)", sandbox);
    return fixture;
  };
  const chooseApi = (id: string) => {
    get("permissionApi").value = id;
    get("permissionApi").onchange!();
  };
  const scopeInput = (scope: string) =>
    get("permissionScopes")
      .querySelectorAll("input")
      .find((input) => input.value === scope)!;
  const checkScope = (scope: string, checked = true) => {
    const input = scopeInput(scope);
    input.checked = checked;
    input.onchange!();
  };
  const draftPermissions = () =>
    JSON.parse(runInNewContext("JSON.stringify(permissionDraft)", sandbox) as string) as {
      resourceAppId: string;
      scopes: string[];
    }[];
  return {
    advanceTime,
    openExistingClient,
    chooseApi,
    scopeInput,
    checkScope,
    draftPermissions,
    startClient,
    rows,
    addUri,
    selectPlatform,
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
describe("Admin copy feedback", () => {
  it.each(["copyAuthority", "copyTenantId", "copyToken"])("copies through %s and uses a notification", async (id) => {
    const ui = await setup();
    if (id === "copyToken") {
      ui.request.mockResolvedValueOnce(result);
      await ui.submit();
    }
    await ui.get(id).onclick!();
    expect(ui.writeText).toHaveBeenCalledWith(
      id === "copyAuthority" ? "http://localhost" : id === "copyTenantId" ? "tenant" : result.access_token,
    );
    expect(ui.get("copyNotice").classes.has("hidden")).toBe(false);
    expect(ui.get("copyMessage").textContent).toContain("コピーしました");
    expect(ui.get("copyNotice").classes.has("error-notice")).toBe(false);
    ui.advanceTime(10000);
    expect(ui.get("copyNotice").classes.has("hidden")).toBe(true);
  });
  it("uses the fallback for clipboard failures and notifies failure without changing the token", async () => {
    const ui = await setup();
    ui.writeText.mockRejectedValue(new Error("denied"));
    await ui.get("copyAuthority").onclick!();
    expect(ui.copyFallback).toHaveBeenCalledWith("http://localhost");
    expect(ui.get("copyMessage").textContent).toContain("コピーしました");
    ui.copyFallback.mockImplementation(() => {
      throw new Error("denied");
    });
    await ui.get("copyTenantId").onclick!();
    expect(ui.get("copyMessage").textContent).toContain("手動でコピー");
    expect(ui.get("copyNotice").classes.has("error-notice")).toBe(true);
  });
  it("uses the fallback once when the Clipboard API is unavailable", async () => {
    const ui = await setup();
    Object.defineProperty(ui.sandbox.navigator, "clipboard", { value: undefined });
    await ui.get("copyTenantId").onclick!();
    expect(ui.copyFallback).toHaveBeenCalledExactlyOnceWith("tenant");
    expect(ui.get("copyMessage").textContent).toContain("コピーしました");
  });
  it.each(["success", "failure"] as const)(
    "ignores an old token copy completing with %s after a new token is issued",
    async (outcome) => {
      const ui = await setup();
      ui.request.mockResolvedValueOnce(result);
      await ui.submit();
      const pending = deferred<void>();
      ui.writeText.mockReturnValueOnce(pending.promise);
      const copying = ui.get("copyToken").onclick!();
      ui.request.mockResolvedValueOnce({ ...result, access_token: "new.jwt.token" });
      await ui.submit();
      if (outcome === "success") pending.resolve();
      else pending.reject(new Error("denied"));
      await copying;
      expect(ui.get("copyNotice").classes.has("hidden")).toBe(true);
      expect(ui.get("issuedToken").value).toBe("new.jwt.token");
      expect(ui.get("issuedToken").select).not.toHaveBeenCalled();
      expect(ui.copyFallback).not.toHaveBeenCalled();
    },
  );
});
describe("Admin platform choices and validation", () => {
  it("clears errors affected by authentication changes while retaining unrelated errors, values, and focus", async () => {
    const ui = await setup();
    await ui.startClient();
    ui.get("clientType").value = "CONFIDENTIAL";
    ui.get("clientType").onchange!();
    ui.selectPlatform("web");
    ui.get("clientSecret").value = "keep-this-secret";
    const uri = ui.rows()[0]!.querySelector("input")!,
      value = uri.value;
    const platformHint = ui.get("platform").getAttribute("aria-describedby");
    ui.request.mockRejectedValueOnce(
      Object.assign(new Error("invalid"), {
        issues: [
          { path: ["clientId"], message: "IDを確認してください" },
          { path: ["clientSecret"], message: "secretを確認してください" },
          { path: ["tokenEndpointAuthMethod"], message: "認証方式を確認してください" },
          { path: ["platform"], message: "platformを確認してください" },
          { path: ["redirectUris", 0], message: "URIを確認してください" },
        ],
      }),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    ui.get("clientType").focus();
    ui.get("clientType").value = "PUBLIC";
    ui.get("clientType").onchange!();
    expect(ui.get("editorError").textContent).toContain("IDを確認してください");
    for (const text of ["secretを確認", "認証方式を確認", "platformを確認", "URIを確認"])
      expect(ui.get("editorError").textContent).not.toContain(text);
    for (const field of [ui.get("clientSecret"), ui.get("authMethod"), ui.get("platform"), uri])
      expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(ui.get("clientId").getAttribute("aria-invalid")).toBe("true");
    expect(ui.get("platform").getAttribute("aria-describedby")).toBe(platformHint);
    expect(ui.get("clientSecret").value).toBe("keep-this-secret");
    expect(uri.value).toBe(value);
    expect(ui.sandbox.document.activeElement).toBe(ui.get("clientType"));
    ui.selectPlatform("native");
    ui.get("clientId").willValidate = true;
    ui.get("clientId").validity = { valid: false, patternMismatch: true };
    ui.request.mockClear();
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    expect(ui.request).not.toHaveBeenCalled();
    expect(ui.get("editorError").textContent).toContain("GUID形式");
    expect(ui.get("editorError").textContent).not.toContain("secret");
  });
  it("clears URI errors after changing platform and revalidates the unchanged URI on submit", async () => {
    const ui = await setup();
    await ui.startClient();
    const uri = ui.rows()[0]!.querySelector("input")!;
    uri.value = "com.example:/callback";
    ui.request.mockImplementation(async (url, options) =>
      options?.method === "POST" ? parseCreateClient(JSON.parse(options.body!)) : ui.readServer(url),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    expect(uri.getAttribute("aria-invalid")).toBe("true");
    ui.get("platform").focus();
    ui.selectPlatform("native");
    expect(uri.getAttribute("aria-invalid")).toBeNull();
    expect(ui.get("editorError").textContent).toBe("");
    expect(uri.value).toBe("com.example:/callback");
    expect(ui.sandbox.document.activeElement).toBe(ui.get("platform"));
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    expect(ui.get("clientEditor").open).toBe(false);
    expect(
      JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "POST")![1]!.body!).redirectUris,
    ).toEqual([{ type: "spa", uri: "com.example:/callback" }]);
    const saves = ui.request.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(JSON.parse(saves[1]![1]!.body!).redirectUris).toEqual([{ type: "native", uri: "com.example:/callback" }]);
  });
  it.each([
    { kind: "user", field: "userGroups", root: "groups", label: "グループ", unrelated: "name" },
    { kind: "resource", field: "resourceScopes", root: "scopes", label: "公開スコープ", unrelated: "identifierUri" },
  ])(
    "retains each invalid entry of $root and removes only identical path/message duplicates",
    async ({ kind, field, root, label, unrelated }) => {
      const ui = await setup();
      await ui.get(kind === "user" ? "newUser" : "newResource").onclick!();
      const form = ui.get(kind + "Form"),
        summary = ui.get(kind + "EditorError"),
        input = ui.get(field);
      input.value = "bad-first\nbad-second";
      const described = input.getAttribute("aria-describedby");
      ui.request.mockRejectedValueOnce(
        Object.assign(new Error("invalid"), {
          issues: [
            { path: [root, 0], message: "形式が正しくありません" },
            { path: [root, 1], message: "形式が正しくありません" },
            { path: [root, 0], message: "形式が正しくありません" },
            { path: [root, 0], message: "別の条件も確認してください" },
            { path: [unrelated], message: "別項目のエラー" },
          ],
        }),
      );
      await form.onsubmit!({ preventDefault: vi.fn() });
      expect(summary.textContent).toContain(label);
      for (const text of [
        "1件目：形式が正しくありません",
        "2件目：形式が正しくありません",
        "1件目：別の条件も確認してください",
      ]) {
        expect(summary.textContent).toContain(text);
        expect(
          form
            .querySelectorAll(".field-error")
            .map((node) => node.textContent)
            .join(" "),
        ).toContain(text);
      }
      expect(summary.textContent.split("1件目：形式が正しくありません")).toHaveLength(2);
      const link = summary.querySelectorAll("button").find((button) => button.textContent.startsWith(label))!;
      await link.onclick!();
      expect(ui.sandbox.document.activeElement).toBe(input);
      form.dispatch("input", { target: input, preventDefault: vi.fn() });
      expect(input.value).toBe("bad-first\nbad-second");
      expect(input.getAttribute("aria-describedby")).toBe(described);
      expect(summary.textContent).not.toContain("件目");
      expect(summary.textContent).toContain("別項目のエラー");
    },
  );
  it("filters platforms by authentication type, clears incompatible choices, and retains URI values", async () => {
    const ui = await setup();
    await ui.startClient();
    const choices = () =>
      ui
        .get("platform")
        .querySelectorAll("option")
        .map((option) => option.value);
    expect(choices()).toEqual(["", "spa", "native"]);
    ui.get("clientType").value = "CONFIDENTIAL";
    ui.get("clientType").onchange!();
    expect(choices()).toEqual(["", "web", "native"]);
    expect(ui.get("platform").value).toBe("");
    expect(ui.get("platformDescription").textContent).toContain("選び直してください");
    expect(ui.rows()[0]!.querySelector("input")!.value).toBe("http://localhost:3000/callback");
    ui.selectPlatform("native");
    ui.get("clientType").value = "PUBLIC";
    ui.get("clientType").onchange!();
    expect(ui.get("platform").value).toBe("native");
    ui.get("clientType").value = "CONFIDENTIAL";
    ui.get("clientType").onchange!();
    ui.selectPlatform("web");
    ui.get("clientType").value = "PUBLIC";
    ui.get("clientType").onchange!();
    expect(ui.get("platform").value).toBe("");
  });
  it("collects native constraint errors before sending and focuses the first invalid field", async () => {
    const ui = await setup();
    await ui.get("newUser").onclick!();
    ui.get("userName").willValidate = true;
    ui.get("userName").validity = { valid: false, valueMissing: true };
    ui.get("userMail").willValidate = true;
    ui.get("userMail").validity = { valid: false, typeMismatch: true };
    await ui.get("userForm").onsubmit!({ preventDefault: vi.fn() });
    expect(ui.request).not.toHaveBeenCalled();
    expect(ui.get("userEditorError").textContent).toContain("表示名");
    expect(ui.get("userEditorError").textContent).toContain("メールアドレス");
    expect(ui.get("userName").getAttribute("aria-invalid")).toBe("true");
    expect(ui.sandbox.document.activeElement).toBe(ui.get("userName"));
    expect(ui.get("userName").scrollIntoView).toHaveBeenCalled();
  });
  it.each(["client", "user", "resource"] as const)(
    "shows HTTP validation issues next to the %s fields, clears edited errors, and retries",
    async (kind) => {
      const ui = await setup();
      if (kind === "client") {
        await ui.startClient();
        await ui.addUri();
      } else await ui.get(kind === "user" ? "newUser" : "newResource").onclick!();
      const form = ui.get(kind + "Form"),
        summary = ui.get(kind === "client" ? "editorError" : kind + "EditorError");
      const first = ui.get(kind === "client" ? "clientId" : kind === "user" ? "userName" : "resourceUri");
      const second =
        kind === "client"
          ? ui.rows()[1]!.querySelector("input")!
          : ui.get(kind === "user" ? "userMail" : "resourceScopes");
      const paths =
        kind === "client"
          ? [["clientId"], ["redirectUris", 1]]
          : kind === "user"
            ? [["name"], ["mail"]]
            : [["identifierUri"], ["scopes", 1]];
      const described = second.getAttribute("aria-describedby");
      const fetch = ui.sandbox.fetch;
      let invalid = true;
      ui.sandbox.fetch = async (url, options) =>
        options?.method === "POST"
          ? {
              ok: !invalid,
              text: async () =>
                JSON.stringify(
                  invalid
                    ? {
                        error: "invalid_" + kind,
                        message: "入力が正しくありません",
                        issues: paths.map((path) => ({ path, message: "修正してください" })),
                      }
                    : JSON.parse(options.body!),
                ),
            }
          : fetch(url, options);
      await form.onsubmit!({ preventDefault: vi.fn() });
      expect(summary.textContent).toContain("修正してください");
      expect(first.getAttribute("aria-invalid")).toBe("true");
      expect(second.getAttribute("aria-invalid")).toBe("true");
      expect(ui.sandbox.document.activeElement).toBe(first);
      await summary.querySelectorAll("button")[1]!.onclick!();
      expect(ui.sandbox.document.activeElement).toBe(second);
      if (described) expect(second.getAttribute("aria-describedby")).toContain(described);
      form.dispatch("input", { target: first, preventDefault: vi.fn() });
      expect(first.getAttribute("aria-invalid")).toBeNull();
      expect(second.getAttribute("aria-invalid")).toBe("true");
      form.dispatch("input", { target: second, preventDefault: vi.fn() });
      expect(second.getAttribute("aria-describedby")).toBe(described);
      expect(summary.textContent).toBe("");
      invalid = false;
      await form.onsubmit!({ preventDefault: vi.fn() });
      expect(ui.get(kind + "Editor").open).toBe(false);
    },
  );
  it("clears field annotations when closing and reopening the form", async () => {
    const ui = await setup();
    await ui.startClient();
    ui.request.mockRejectedValueOnce(
      Object.assign(new Error("invalid"), {
        issues: [{ path: ["redirectUris", 0], message: "URIを確認してください" }],
      }),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const input = ui.rows()[0]!.querySelector("input")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await ui.get("cancelClient").onclick!();
    expect(input.getAttribute("aria-invalid")).toBeNull();
    await ui.get("newClient").onclick!();
    expect(ui.get("editorError").textContent).toBe("");
  });
});
describe("Admin API permission selection", () => {
  it("adds permissions across APIs, merges scopes, and saves the existing JSON format", async () => {
    const ui = await setup();
    const first = resource(),
      second = resource("66666666-6666-4666-8666-666666666666");
    ui.server.resources = [first, second];
    await ui.startClient();
    expect(ui.draftPermissions()).toEqual([]);
    await ui.get("addPermission").onclick!();
    expect(ui.get("saveClient").disabled).toBe(true);
    expect(ui.get("applyPermission").disabled).toBe(true);
    ui.chooseApi(first.resourceAppId);
    expect(
      ui
        .get("permissionScopes")
        .querySelectorAll("input")
        .every((input) => !input.checked),
    ).toBe(true);
    ui.checkScope("api.read");
    ui.chooseApi(second.resourceAppId);
    ui.checkScope("access_as_user");
    ui.chooseApi(first.resourceAppId);
    expect(ui.scopeInput("api.read").checked).toBe(true);
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    expect(ui.request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    await ui.get("applyPermission").onclick!();
    expect(ui.get("saveClient").disabled).toBe(false);
    expect(ui.get("permissions").querySelectorAll("button")).toHaveLength(2);
    await ui.get("addPermission").onclick!();
    ui.chooseApi(first.resourceAppId);
    expect(ui.scopeInput("api.read").checked).toBe(true);
    expect(ui.scopeInput("api.read").disabled).toBe(true);
    ui.checkScope("api.write");
    await ui.get("applyPermission").onclick!();
    ui.request.mockImplementation(async (url, options) =>
      options?.method === "POST" ? parseCreateClient(JSON.parse(options.body!)) : ui.readServer(url),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "POST")![1]!.body!);
    expect(body.requiredResourceAccess).toEqual([
      { resourceAppId: first.resourceAppId, scopes: ["api.read", "api.write"] },
      { resourceAppId: second.resourceAppId, scopes: ["access_as_user"] },
    ]);
    expect(ui.get("clientEditor").open).toBe(false);
  });
  it("removes scopes individually and drops the API entry after its last scope", async () => {
    const ui = await setup();
    const fixture = ui.openExistingClient();
    const second = { resourceAppId: "66666666-6666-4666-8666-666666666666", scopes: ["api.read"] };
    fixture.requiredResourceAccess[0]!.scopes.push("api.write");
    fixture.requiredResourceAccess.push(second);
    runInNewContext("openClient(fixture)", ui.sandbox);
    const remove = ui.get("permissions").querySelector("button")!;
    expect(remove.dataset.scope).toBe("access_as_user");
    await remove.onclick!();
    expect(ui.draftPermissions()).toEqual([{ resourceAppId: resource().resourceAppId, scopes: ["api.write"] }, second]);
    await ui.get("permissions").querySelector("button")!.onclick!();
    expect(ui.draftPermissions()).toEqual([second]);
    await ui.get("permissions").querySelector("button")!.onclick!();
    expect(ui.draftPermissions()).toEqual([]);
    expect(ui.get("permissions").textContent).toContain("未設定");
    ui.sandbox.confirm.mockReturnValue(false);
    await ui.get("cancelClient").onclick!();
    expect(ui.sandbox.confirm).toHaveBeenCalledWith("未保存の変更を破棄しますか？");
    expect(ui.get("clientEditor").open).toBe(true);
  });
  it("does not count API browsing as a change, but confirms discarding pending scope selections", async () => {
    const ui = await setup();
    ui.server.resources = [resource()];
    ui.openExistingClient();
    await ui.get("addPermission").onclick!();
    ui.chooseApi(resource().resourceAppId);
    await ui.get("cancelClient").onclick!();
    expect(ui.sandbox.confirm).not.toHaveBeenCalled();
    expect(ui.get("clientEditor").open).toBe(false);
    ui.openExistingClient();
    await ui.get("addPermission").onclick!();
    ui.chooseApi(resource().resourceAppId);
    ui.checkScope("api.read");
    ui.sandbox.confirm.mockReturnValue(false);
    await ui.get("cancelClient").onclick!();
    expect(ui.sandbox.confirm).toHaveBeenCalledTimes(1);
    expect(ui.get("clientEditor").open).toBe(true);
    expect(ui.scopeInput("api.read").checked).toBe(true);
    await ui.get("cancelPermission").onclick!();
    expect(ui.draftPermissions()).toEqual(client().requiredResourceAccess);
    expect(ui.get("saveClient").disabled).toBe(false);
    await ui.get("cancelClient").onclick!();
    expect(ui.sandbox.confirm).toHaveBeenCalledTimes(1);
    expect(ui.get("clientEditor").open).toBe(false);
  });
  it("confirms discarding permissions committed to the client draft and resets the next editor", async () => {
    const ui = await setup();
    ui.server.resources = [resource()];
    ui.openExistingClient();
    await ui.get("addPermission").onclick!();
    ui.chooseApi(resource().resourceAppId);
    ui.checkScope("api.read");
    await ui.get("applyPermission").onclick!();
    await ui.get("cancelClient").onclick!();
    expect(ui.sandbox.confirm).toHaveBeenCalledTimes(1);
    await ui.get("newClient").onclick!();
    expect(ui.draftPermissions()).toEqual([]);
    expect(ui.get("permissionPicker").classes.has("hidden")).toBe(true);
    expect(ui.get("saveClient").disabled).toBe(false);
  });
  it("guides users to register an API when there are no candidates", async () => {
    const ui = await setup();
    await ui.startClient();
    await ui.get("addPermission").onclick!();
    expect(ui.get("permissionCatalogMessage").textContent).toContain("先に自APIと公開スコープを登録");
    expect(ui.sandbox.document.activeElement).toBe(ui.get("cancelPermission"));
    expect(ui.get("applyPermission").disabled).toBe(true);
    await ui.get("cancelPermission").onclick!();
    expect(ui.get("saveClient").disabled).toBe(false);
  });
  it("keeps existing permissions after a catalogue failure and fetches again when reopened", async () => {
    const ui = await setup();
    ui.server.resources = [resource()];
    const fixture = ui.openExistingClient();
    ui.request.mockRejectedValueOnce(new Error("catalogue unavailable"));
    await ui.get("addPermission").onclick!();
    expect(ui.get("permissionCatalogMessage").textContent).toContain("catalogue unavailable");
    expect(ui.get("permissionCatalogMessage").textContent).toContain("もう一度「権限を追加」を開いてください");
    expect(ui.get("applyPermission").disabled).toBe(true);
    expect(ui.get("permissionApi").disabled).toBe(true);
    expect(ui.draftPermissions()).toEqual(fixture.requiredResourceAccess);
    expect(ui.sandbox.document.activeElement).toBe(ui.get("cancelPermission"));
    expect(ui.get("issueToken").disabled).toBe(false);
    await ui.get("cancelPermission").onclick!();
    await ui.get("addPermission").onclick!();
    expect(ui.get("permissionApi").disabled).toBe(false);
    expect(ui.get("permissionCatalogMessage").textContent).toBe("");
    expect(ui.sandbox.document.activeElement).toBe(ui.get("permissionApi"));
    await ui.get("cancelPermission").onclick!();
    ui.request.mockRejectedValueOnce(new Error("offline again"));
    await ui.get("addPermission").onclick!();
    expect(ui.request.mock.calls.filter(([url]) => url === "/__mock/api/resources")).toHaveLength(3);
    await ui.get("cancelPermission").onclick!();
    ui.request.mockImplementation(async (url, options) => (options?.method === "PUT" ? fixture : ui.readServer(url)));
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "PUT")![1]!.body!);
    expect(body.requiredResourceAccess).toEqual(fixture.requiredResourceAccess);
  });
  it("reuses an ongoing initial API list fetch and disables selection until it completes", async () => {
    const initial = deferred<unknown>();
    const ui = await setup({ resources: initial.promise });
    ui.openExistingClient();
    const opening = ui.get("addPermission").onclick!();
    expect(ui.sandbox.document.activeElement).toBe(ui.get("cancelPermission"));
    expect(ui.request.mock.calls.filter(([url]) => url === "/__mock/api/resources")).toHaveLength(0);
    expect(ui.get("permissionCatalogMessage").textContent).toContain("読み込み中");
    expect(ui.get("permissionApi").disabled).toBe(true);
    expect(ui.get("applyPermission").disabled).toBe(true);
    initial.resolve([resource()]);
    await opening;
    expect(ui.get("permissionApi").disabled).toBe(false);
    expect(ui.sandbox.document.activeElement).toBe(ui.get("permissionApi"));
    expect(
      ui
        .get("permissionApi")
        .querySelectorAll("option")
        .map((option) => option.textContent),
    ).toContain(resource().identifierUri);
    expect(ui.draftPermissions()).toEqual(client().requiredResourceAccess);
  });
  it.each(["success", "failure"] as const)(
    "keeps focus in another input when catalogue loading finishes with %s",
    async (outcome) => {
      const ui = await setup();
      await ui.startClient();
      const pending = deferred<unknown>();
      ui.request.mockReturnValueOnce(pending.promise);
      const opening = ui.get("addPermission").onclick!();
      expect(ui.sandbox.document.activeElement).toBe(ui.get("cancelPermission"));
      const uri = ui.rows()[0]!.querySelector("input")!;
      uri.focus();
      if (outcome === "success") pending.resolve([resource()]);
      else pending.reject(new Error("catalogue unavailable"));
      await opening;
      expect(ui.sandbox.document.activeElement).toBe(uri);
      expect(ui.get("permissionApi").disabled).toBe(outcome === "failure");
      expect(ui.draftPermissions()).toEqual([]);
    },
  );
  it("does not change focus after the permission picker is closed during loading", async () => {
    const ui = await setup();
    await ui.startClient();
    const pending = deferred<unknown>();
    ui.request.mockReturnValueOnce(pending.promise);
    const opening = ui.get("addPermission").onclick!();
    await ui.get("cancelPermission").onclick!();
    expect(ui.sandbox.document.activeElement).toBe(ui.get("addPermission"));
    pending.resolve([resource()]);
    await opening;
    expect(ui.get("permissionPicker").classes.has("hidden")).toBe(true);
    expect(ui.sandbox.document.activeElement).toBe(ui.get("addPermission"));
  });
  it("ignores the focus continuation of an older picker after reopening with a newer catalogue", async () => {
    const ui = await setup();
    await ui.startClient();
    const old = deferred<unknown>(),
      current = deferred<unknown>();
    ui.request.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const oldOpening = ui.get("addPermission").onclick!();
    await ui.get("cancelPermission").onclick!();
    const loading = ui.load("resource");
    const opening = ui.get("addPermission").onclick!();
    const fresh = resource("66666666-6666-4666-8666-666666666666");
    current.resolve([fresh]);
    await loading;
    await opening;
    expect(ui.sandbox.document.activeElement).toBe(ui.get("permissionApi"));
    ui.chooseApi(fresh.resourceAppId);
    ui.checkScope("api.read");
    ui.get("cancelPermission").focus();
    old.resolve([resource()]);
    await oldOpening;
    expect(ui.sandbox.document.activeElement).toBe(ui.get("cancelPermission"));
    expect(ui.get("permissionApi").value).toBe(fresh.resourceAppId);
    expect(ui.scopeInput("api.read").checked).toBe(true);
    await ui.get("applyPermission").onclick!();
    expect(ui.draftPermissions()).toEqual([{ resourceAppId: fresh.resourceAppId, scopes: ["api.read"] }]);
  });
  it("ignores an older catalogue response after a newer list load", async () => {
    const ui = await setup();
    ui.openExistingClient();
    const old = deferred<unknown>(),
      latest = deferred<unknown>();
    ui.request.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const opening = ui.get("addPermission").onclick!();
    const reload = runInNewContext("resourceEditor.load()", ui.sandbox) as Promise<void>;
    const fresh = { ...resource(), identifierUri: "api://latest", scopes: ["fresh.read"] };
    latest.resolve([fresh]);
    await reload;
    ui.chooseApi(fresh.resourceAppId);
    ui.checkScope("fresh.read");
    old.resolve([resource()]);
    await opening;
    expect(ui.scopeInput("fresh.read").checked).toBe(true);
    expect(
      ui
        .get("permissionApi")
        .querySelectorAll("option")
        .map((option) => option.textContent),
    ).toContain("api://latest");
    expect(ui.get("resourceCount").textContent).toBe("（1 件）");
    await ui.get("applyPermission").onclick!();
    expect(ui.draftPermissions()[0]!.scopes).toEqual(["access_as_user", "fresh.read"]);
  });
  it("uses a resource reset response instead of an older in-flight GET", async () => {
    const ui = await setup();
    ui.openExistingClient();
    const old = deferred<unknown>();
    ui.request.mockReturnValueOnce(old.promise);
    const opening = ui.get("addPermission").onclick!();
    const fresh = resource("66666666-6666-4666-8666-666666666666");
    ui.request.mockResolvedValueOnce([fresh]);
    await ui.get("resetResources").onclick!();
    old.resolve([resource()]);
    await opening;
    expect(
      ui
        .get("permissionApi")
        .querySelectorAll("option")
        .map((option) => option.value),
    ).toEqual(["", fresh.resourceAppId]);
    expect(ui.get("permissionApi").disabled).toBe(false);
    expect(ui.draftPermissions()).toEqual(client().requiredResourceAccess);
  });
  it("preserves pending selections during shared API list updates and blocks removed scopes", async () => {
    const ui = await setup();
    const first = resource(),
      second = resource("66666666-6666-4666-8666-666666666666");
    ui.server.resources = [first, second];
    await ui.startClient();
    await ui.get("addPermission").onclick!();
    ui.chooseApi(first.resourceAppId);
    ui.checkScope("api.read");
    ui.chooseApi(second.resourceAppId);
    ui.checkScope("api.write");
    ui.request.mockRejectedValueOnce(new Error("temporarily offline"));
    await ui.load("resource");
    expect(ui.scopeInput("api.write").checked).toBe(true);
    expect(ui.get("applyPermission").disabled).toBe(true);
    ui.server.resources = [{ ...first, scopes: ["api.read"] }];
    await ui.load("resource");
    expect(ui.scopeInput("api.write").checked).toBe(true);
    expect(ui.get("permissionPickerError").textContent).toContain("登録が変更");
    expect(ui.get("applyPermission").disabled).toBe(true);
    ui.checkScope("api.write", false);
    expect(ui.get("applyPermission").disabled).toBe(false);
    await ui.get("applyPermission").onclick!();
    expect(ui.draftPermissions()).toEqual([{ resourceAppId: first.resourceAppId, scopes: ["api.read"] }]);
  });
  it("marks missing saved references and lets users remove them", async () => {
    const ui = await setup();
    ui.openExistingClient();
    expect(
      ui
        .get("permissions")
        .querySelectorAll("td")
        .map((cell) => cell.textContent),
    ).toContain("access_as_user（未登録）");
    await ui.get("permissions").querySelector("button")!.onclick!();
    expect(ui.draftPermissions()).toEqual([]);
  });
  it("keeps rebuilt controls disabled during save and preserves the draft on failure", async () => {
    const ui = await setup();
    const fixture = ui.openExistingClient();
    const pending = deferred<unknown>();
    ui.request.mockReturnValueOnce(pending.promise);
    const saving = ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    ui.server.resources = [resource()];
    await runInNewContext("resourceEditor.load()", ui.sandbox);
    expect(ui.get("permissions").querySelector("button")!.disabled).toBe(true);
    expect(ui.get("addPermission").disabled).toBe(true);
    expect(ui.get("saveClient").disabled).toBe(true);
    pending.reject(new Error("save failed"));
    await saving;
    expect(ui.get("permissions").querySelector("button")!.disabled).toBe(false);
    expect(ui.get("saveClient").disabled).toBe(false);
    expect(ui.draftPermissions()).toEqual(fixture.requiredResourceAccess);
    expect(ui.get("editorError").textContent).toContain("save failed");
  });
});
describe("Admin API token attributes", () => {
  it("enables both attributes for a new API and saves the existing schema", async () => {
    const ui = await setup();
    await ui.get("newResource").onclick!();
    expect(ui.get("resourceGroups").checked).toBe(true);
    expect(ui.get("resourceEmail").checked).toBe(true);
    ui.request.mockImplementation(async (url, options) =>
      options?.method === "POST" ? resourceSchema.parse(JSON.parse(options.body!)) : ui.readServer(url),
    );
    await ui.get("resourceForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "POST")![1]!.body!);
    expect(body).toMatchObject({ emailOptionalClaim: true, groupMembershipClaims: "SecurityGroup" });
    expect(ui.get("resourceEditor").open).toBe(false);
  });
  it.each([
    { email: false, groups: false },
    { email: true, groups: false },
    { email: false, groups: true },
    { email: true, groups: true },
  ])("loads and saves API attribute choices: $email / $groups", async ({ email, groups }) => {
    const ui = await setup();
    const fixture = {
      ...resource(),
      emailOptionalClaim: email,
      groupMembershipClaims: groups ? "SecurityGroup" : "None",
    };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openResource(fixture)", ui.sandbox);
    expect(ui.get("resourceEmail").checked).toBe(email);
    expect(ui.get("resourceGroups").checked).toBe(groups);
    ui.get("resourceEmail").checked = !email;
    ui.get("resourceGroups").checked = !groups;
    ui.request.mockImplementation(async (url, options) =>
      options?.method === "PUT"
        ? { resourceAppId: fixture.resourceAppId, ...updateResourceSchema.parse(JSON.parse(options.body!)) }
        : ui.readServer(url),
    );
    await ui.get("resourceForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "PUT")![1]!.body!);
    expect(body).toMatchObject({
      emailOptionalClaim: !email,
      groupMembershipClaims: groups ? "None" : "SecurityGroup",
    });
    expect(body).not.toHaveProperty("resourceAppId");
    expect(ui.get("resourceEditor").open).toBe(false);
  });
  it.each(["resourceGroups", "resourceEmail"])("confirms discarding API checkbox edits: %s", async (id) => {
    const ui = await setup();
    await ui.get("newResource").onclick!();
    await ui.get("cancelResource").onclick!();
    expect(ui.sandbox.confirm).not.toHaveBeenCalled();
    await ui.get("newResource").onclick!();
    ui.get(id).checked = false;
    ui.sandbox.confirm.mockReturnValue(false);
    await ui.get("cancelResource").onclick!();
    expect(ui.sandbox.confirm).toHaveBeenCalledWith("未保存の変更を破棄しますか？");
    expect(ui.get("resourceEditor").open).toBe(true);
    expect(ui.get(id).checked).toBe(false);
  });
  it("retains disabled attributes on a failed save and restores defaults for the next API", async () => {
    const ui = await setup();
    await ui.get("newResource").onclick!();
    ui.get("resourceGroups").checked = false;
    ui.get("resourceEmail").checked = false;
    const pending = deferred<unknown>();
    ui.request.mockReturnValueOnce(pending.promise);
    const saving = ui.get("resourceForm").onsubmit!({ preventDefault: vi.fn() });
    for (const id of ["resourceGroups", "resourceEmail", "closeResource", "cancelResource", "saveResource"])
      expect(ui.get(id).disabled).toBe(true);
    await ui.get("cancelResource").onclick!();
    expect(ui.get("resourceEditor").open).toBe(true);
    pending.reject(new Error("save failed"));
    await saving;
    expect(ui.get("resourceGroups").checked).toBe(false);
    expect(ui.get("resourceEmail").checked).toBe(false);
    expect(ui.get("resourceEditorError").textContent).toContain("save failed");
    for (const id of ["resourceGroups", "resourceEmail", "closeResource", "cancelResource", "saveResource"])
      expect(ui.get(id).disabled).toBe(false);
    await ui.get("cancelResource").onclick!();
    await ui.get("newResource").onclick!();
    expect(ui.get("resourceGroups").checked).toBe(true);
    expect(ui.get("resourceEmail").checked).toBe(true);
  });
});
describe("Admin shared controls and notices", () => {
  it("requires the secret only for confidential clients and restores the fields after a failed save", async () => {
    const ui = await setup();
    await ui.startClient("web");
    expect(ui.get("clientSecret").required).toBe(false);
    expect(ui.get("clientSecret").disabled).toBe(true);
    expect(ui.get("authMethod").disabled).toBe(true);
    ui.get("clientType").value = "CONFIDENTIAL";
    ui.get("clientType").onchange!();
    expect(ui.get("clientSecret").required).toBe(true);
    expect(ui.get("clientSecret").disabled).toBe(false);
    expect(ui.get("authMethod").disabled).toBe(false);
    ui.get("clientSecret").value = "test-secret";
    const pending = deferred<unknown>();
    ui.request.mockReturnValueOnce(pending.promise);
    const saving = ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    expect(ui.get("clientSecret").disabled).toBe(true);
    pending.reject(new Error("save failed"));
    await saving;
    expect(ui.get("clientSecret").disabled).toBe(false);
    expect(ui.get("clientSecret").required).toBe(true);
    expect(ui.get("clientSecret").value).toBe("test-secret");
    ui.get("clientType").value = "PUBLIC";
    ui.get("clientType").onchange!();
    expect(ui.get("clientSecret").required).toBe(false);
    expect(ui.get("clientSecret").disabled).toBe(true);
    expect(ui.get("authMethod").disabled).toBe(true);
  });
  it.each(["delete", "reset"] as const)("shows API %s success and lets the notice be dismissed", async (action) => {
    const ui = await setup();
    ui.server.resources = [resource()];
    await ui.load("resource");
    ui.request.mockImplementation(async (url, options) => {
      if (options?.method === "DELETE") {
        ui.server.resources = [];
        return undefined;
      }
      if (url.endsWith("/reset")) return ui.server.resources;
      return ui.readServer(url);
    });
    if (action === "reset") await ui.get("resetResources").onclick!();
    else
      await ui
        .get("resources")
        .querySelectorAll("button")
        .find((button) => button.textContent === "削除")!.onclick!();
    expect(ui.get("resourceMessage").textContent).toContain(
      action === "reset" ? "初期状態に戻しました" : "削除しました",
    );
    expect(ui.get("resourceNotice").classes.has("hidden")).toBe(false);
    if (action === "delete") {
      expect(ui.get("resourceCount").textContent).toBe("（0 件）");
      expect(ui.get("resources").textContent).toBe("登録済みのAPIはありません。");
      expect(ui.get("resources").querySelectorAll("table")).toHaveLength(0);
    }
    ui.get("resourcePanel").open = false;
    ui.get("newResource").closest = () => ui.get("resourcePanel");
    await ui.get("dismissResourceNotice").onclick!();
    expect(ui.get("resourceNotice").classes.has("hidden")).toBe(true);
    expect(ui.get("resourceMessage").textContent).toBe("");
    expect(ui.get("resourcePanel").open).toBe(true);
    expect(ui.get("newResource").focus).toHaveBeenCalled();
  });
  it.each(["delete", "reset"] as const)("keeps the API list and shows an error if %s fails", async (action) => {
    const ui = await setup();
    ui.server.resources = [resource()];
    await ui.load("resource");
    ui.request.mockRejectedValueOnce(new Error("mutation failed"));
    if (action === "reset") await ui.get("resetResources").onclick!();
    else
      await ui
        .get("resources")
        .querySelectorAll("button")
        .find((button) => button.textContent === "削除")!.onclick!();
    expect(ui.get("resourceError").textContent).toContain("mutation failed");
    expect(ui.get("resourceMessage").textContent).toBe("");
    expect(ui.get("resourceCount").textContent).toBe("（1 件）");
    expect(ui.get("resources").querySelectorAll("button")).toHaveLength(2);
  });
  it("keeps successful API deletion visible when the following list fetch fails", async () => {
    const ui = await setup();
    ui.server.resources = [resource()];
    await ui.load("resource");
    ui.request.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("list unavailable"));
    await ui
      .get("resources")
      .querySelectorAll("button")
      .find((button) => button.textContent === "削除")!.onclick!();
    expect(ui.get("resourceMessage").textContent).toContain("削除しました");
    expect(ui.get("resourceError").textContent).toContain("list unavailable");
    expect(ui.get("retryResources").classes.has("hidden")).toBe(false);
  });
  it("dismisses and expires notifications independently", async () => {
    const ui = await setup();
    runInNewContext(
      "resourceEditor.notice('API saved'); userEditor.notice('User saved'); clientEditor.notice('Client saved');",
      ui.sandbox,
    );
    expect(ui.sandbox.setTimeout.mock.calls.map(([, delay]) => delay)).toEqual([10000, 10000, 10000]);
    ui.advanceTime(5000);
    await ui.get("dismissUserNotice").onclick!();
    expect(ui.get("userNotice").classes.has("hidden")).toBe(true);
    expect(ui.get("resourceNotice").classes.has("hidden")).toBe(false);
    expect(ui.get("clientNotice").classes.has("hidden")).toBe(false);
    runInNewContext("userEditor.notice('User updated');", ui.sandbox);
    ui.advanceTime(5000);
    expect(ui.get("resourceNotice").classes.has("hidden")).toBe(true);
    expect(ui.get("clientNotice").classes.has("hidden")).toBe(true);
    expect(ui.get("userMessage").textContent).toBe("User updated");
    expect(ui.get("userNotice").classes.has("hidden")).toBe(false);
    ui.advanceTime(5000);
    expect(ui.get("userNotice").classes.has("hidden")).toBe(true);
  });
  it.each([
    ["mouseenter", "mouseleave"],
    ["focusin", "focusout"],
  ])("pauses one notification on %s without changing another notification's timer", async (pause, resume) => {
    const ui = await setup();
    runInNewContext("resourceEditor.notice('API saved'); clientEditor.notice('Client saved');", ui.sandbox);
    ui.advanceTime(5000);
    ui.get("resourceNotice").dispatch(pause, { preventDefault: vi.fn() });
    ui.advanceTime(5000);
    expect(ui.get("clientNotice").classes.has("hidden")).toBe(true);
    expect(ui.get("resourceNotice").classes.has("hidden")).toBe(false);
    ui.get("resourceNotice").dispatch(resume, { preventDefault: vi.fn() });
    ui.advanceTime(9999);
    expect(ui.get("resourceNotice").classes.has("hidden")).toBe(false);
    ui.advanceTime(1);
    expect(ui.get("resourceNotice").classes.has("hidden")).toBe(true);
  });
});
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
  it("round-trips one platform with multiple URI rows and API permissions", async () => {
    const ui = await setup();
    const fixture = {
      ...client(),
      emailOptionalClaim: true,
      groupMembershipClaims: "SecurityGroup",
      redirectUris: [
        { type: "spa", uri: "https://app.example.test/callback" },
        { type: "spa", uri: "https://app.example.test/logout" },
      ],
      requiredResourceAccess: [
        { resourceAppId: "55555555-5555-4555-8555-555555555555", scopes: ["read", "write"] },
        { resourceAppId: "66666666-6666-4666-8666-666666666666", scopes: ["read"] },
      ],
    };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openClient(fixture)", ui.sandbox);
    expect(ui.get("platform").value).toBe("spa");
    expect(ui.rows().map((row) => row.querySelector("input")!.value)).toEqual(
      fixture.redirectUris.map((item) => item.uri),
    );
    expect(ui.get("platformMixedHint").classes.has("hidden")).toBe(true);
    ui.request.mockImplementation((url, options) =>
      options?.method === "PUT" ? Promise.resolve(fixture) : ui.readServer(url),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "PUT")![1]!.body!);
    const expected: Record<string, unknown> = { ...fixture, tokenEndpointAuthMethod: "none" };
    delete expected.clientId;
    expect(body).toEqual(expected);
  });
  it("enables both ID-token attributes by default when creating a client", async () => {
    const ui = await setup();
    await ui.startClient();
    expect(ui.get("clientGroups").checked).toBe(true);
    expect(ui.get("emailOptionalClaim").checked).toBe(true);
    ui.request.mockImplementation(async (url, options) =>
      options?.method === "POST" ? parseCreateClient(JSON.parse(options.body!)) : ui.readServer(url),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "POST")![1]!.body!);
    expect(body).toMatchObject({ emailOptionalClaim: true, groupMembershipClaims: "SecurityGroup" });
    expect(body.requiredResourceAccess).toEqual([]);
  });
  it.each([
    { email: false, groups: false },
    { email: true, groups: false },
    { email: false, groups: true },
    { email: true, groups: true },
  ])("loads and saves existing attribute choices: $email / $groups", async ({ email, groups }) => {
    const ui = await setup();
    const fixture = {
      ...client(),
      emailOptionalClaim: email,
      groupMembershipClaims: groups ? "SecurityGroup" : "None",
      redirectUris: [{ type: "spa", uri: "https://app.example.test/callback" }],
    };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openClient(fixture)", ui.sandbox);
    expect(ui.get("emailOptionalClaim").checked).toBe(email);
    expect(ui.get("clientGroups").checked).toBe(groups);
    ui.get("emailOptionalClaim").checked = !email;
    ui.get("clientGroups").checked = !groups;
    ui.request.mockImplementation(async (url, options) =>
      options?.method === "PUT"
        ? { clientId: fixture.clientId, ...parseUpdateClient(JSON.parse(options.body!)) }
        : ui.readServer(url),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "PUT")![1]!.body!);
    expect(body).toMatchObject({
      emailOptionalClaim: !email,
      groupMembershipClaims: groups ? "None" : "SecurityGroup",
    });
  });
  it.each(["clientGroups", "emailOptionalClaim"])("detects unsaved checkbox changes: %s", async (id) => {
    const ui = await setup();
    await ui.startClient();
    const fixture = {
      ...client(),
      emailOptionalClaim: true,
      groupMembershipClaims: "SecurityGroup",
      redirectUris: [{ type: "spa", uri: "https://app.example.test/callback" }],
    };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openClient(fixture)", ui.sandbox);
    ui.get(id).checked = false;
    ui.sandbox.confirm.mockReturnValue(false);
    await ui.get("cancelClient").onclick!();
    expect(ui.sandbox.confirm).toHaveBeenCalledWith("未保存の変更を破棄しますか？");
    expect(ui.get("clientEditor").open).toBe(true);
  });
  it("retains disabled attributes after a failed save and restores defaults for a new client", async () => {
    const ui = await setup();
    await ui.startClient();
    ui.get("clientGroups").checked = false;
    ui.get("emailOptionalClaim").checked = false;
    const pending = deferred<unknown>();
    ui.request.mockReturnValueOnce(pending.promise);
    const save = ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    expect(ui.get("clientGroups").disabled).toBe(true);
    expect(ui.get("emailOptionalClaim").disabled).toBe(true);
    pending.reject(new Error("save failed"));
    await save;
    expect(ui.get("clientGroups").checked).toBe(false);
    expect(ui.get("emailOptionalClaim").checked).toBe(false);
    expect(ui.get("clientGroups").disabled).toBe(false);
    expect(ui.get("emailOptionalClaim").disabled).toBe(false);
    await ui.get("cancelClient").onclick!();
    await ui.get("newClient").onclick!();
    expect(ui.get("clientGroups").checked).toBe(true);
    expect(ui.get("emailOptionalClaim").checked).toBe(true);
  });
  it("retains every legacy URI and requires an explicit platform before converting mixed settings", async () => {
    const ui = await setup();
    const fixture = {
      ...client(),
      emailOptionalClaim: false,
      groupMembershipClaims: "None",
      redirectUris: [
        { type: "spa", uri: "https://app.example.test/callback" },
        { type: "native", uri: "com.example:/callback" },
        { type: "spa", uri: "https://app.example.test/logout" },
      ],
    };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openClient(fixture)", ui.sandbox);
    expect(ui.get("platform").value).toBe("");
    expect(ui.get("platformMixedHint").classes.has("hidden")).toBe(false);
    expect(ui.rows().map((row) => row.querySelector("input")!.value)).toEqual(
      fixture.redirectUris.map((item) => item.uri),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    expect(ui.request).not.toHaveBeenCalled();
    expect(ui.get("editorError").textContent).toContain("1つ選択");
    ui.selectPlatform("native");
    ui.request.mockImplementation(async (url, options) =>
      options?.method === "PUT"
        ? { clientId: fixture.clientId, ...parseUpdateClient(JSON.parse(options.body!)) }
        : ui.readServer(url),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "PUT")![1]!.body!);
    expect(body.redirectUris).toEqual(fixture.redirectUris.map((item) => ({ type: "native", uri: item.uri })));
    expect(ui.get("clientEditor").open).toBe(false);
  });
  it("can cancel viewing legacy mixed settings without changing or saving them", async () => {
    const ui = await setup();
    const fixture = {
      ...client(),
      redirectUris: [
        { type: "spa", uri: "https://app.example.test/callback" },
        { type: "native", uri: "com.example:/callback" },
      ],
    };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openClient(fixture)", ui.sandbox);
    await ui.get("cancelClient").onclick!();
    expect(ui.sandbox.confirm).not.toHaveBeenCalled();
    expect(ui.request).not.toHaveBeenCalled();
    expect(fixture.redirectUris.map((item) => item.type)).toEqual(["spa", "native"]);
  });
  it("keeps existing mixed-platform settings readable in the client list", async () => {
    const ui = await setup();
    const fixture = {
      ...client(),
      redirectUris: [
        { type: "spa", uri: "https://app.example.test/callback" },
        { type: "native", uri: "com.example:/callback" },
        { type: "spa", uri: "https://app.example.test/logout" },
      ],
    };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("renderClients([fixture])", ui.sandbox);
    const summaries = ui.get("clients").querySelectorAll(".platform-summary");
    expect(summaries.map((group) => group.querySelector("strong")!.textContent)).toEqual([
      "シングルページアプリケーション（SPA）",
      "モバイル／デスクトップ",
    ]);
    expect(summaries[0]!.querySelectorAll("div").map((row) => row.textContent)).toEqual([
      "https://app.example.test/callback",
      "https://app.example.test/logout",
    ]);
  });
  it.each([
    { method: "POST", type: "spa", uri: "https://app.example.test/callback" },
    { method: "PUT", type: "spa", uri: "https://app.example.test/callback" },
    { method: "POST", type: "native", uri: "com.example.app:/callback" },
    { method: "PUT", type: "native", uri: "com.example.app:/callback" },
  ])("trims pasted URIs for $type via $method", async ({ method, type, uri }) => {
    const ui = await setup();
    const fixture = {
      ...client(),
      emailOptionalClaim: false,
      groupMembershipClaims: "None",
      redirectUris: [
        { type, uri },
        { type, uri: "https://app.example.test/logout" },
      ],
    };
    if (method === "POST") {
      await ui.startClient(type);
      await ui.addUri();
    } else {
      Object.assign(ui.sandbox, { fixture });
      runInNewContext("openClient(fixture)", ui.sandbox);
    }
    ui.rows().forEach((row, index) => {
      row.querySelector("input")!.value = "  " + fixture.redirectUris[index]!.uri + " \u00a0";
    });
    ui.request.mockImplementation(async (url, options) => {
      if (options?.method !== method) return ui.readServer(url);
      const payload = JSON.parse(options.body!);
      return method === "POST"
        ? parseCreateClient(payload)
        : { clientId: fixture.clientId, ...parseUpdateClient(payload) };
    });
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === method)![1]!.body!);
    expect(body.redirectUris).toEqual(fixture.redirectUris);
    expect(ui.get("clientEditor").open).toBe(false);
  });
  it.each(["POST", "PUT"])("preserves a full 256-character URI pasted with spaces via %s", async (method) => {
    const ui = await setup(),
      prefix = "https://app.example.test/",
      uri = prefix + "a".repeat(256 - prefix.length);
    const fixture = {
      ...client(),
      emailOptionalClaim: false,
      groupMembershipClaims: "None",
      redirectUris: [{ type: "spa", uri }],
    };
    if (method === "POST") await ui.startClient();
    else {
      Object.assign(ui.sandbox, { fixture });
      runInNewContext("openClient(fixture)", ui.sandbox);
    }
    const input = ui.rows()[0]!.querySelector("input")!;
    expect(input.maxLength).toBe(-1);
    input.value = " " + uri + " ";
    ui.request.mockImplementation(async (url, options) => {
      if (options?.method !== method) return ui.readServer(url);
      const payload = JSON.parse(options.body!);
      return method === "POST"
        ? parseCreateClient(payload)
        : { clientId: fixture.clientId, ...parseUpdateClient(payload) };
    });
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === method)![1]!.body!);
    expect(body.redirectUris).toEqual([{ type: "spa", uri }]);
    expect(ui.get("clientEditor").open).toBe(false);
  });
  it.each([
    { input: " https://app.example.test/with space ", expected: "https://app.example.test/with space" },
    { input: "   \u00a0", expected: "" },
    {
      input: " https://app.example.test/" + "a".repeat(233) + " ",
      expected: "https://app.example.test/" + "a".repeat(233),
    },
  ])("preserves invalid URI input after a failed save: $expected", async ({ input, expected }) => {
    const ui = await setup();
    await ui.startClient();
    await ui.addUri();
    const rows = ui.rows();
    rows[1]!.querySelector("input")!.value = input;
    ui.request.mockImplementation(async (url, options) =>
      options?.method === "POST" ? parseCreateClient(JSON.parse(options.body!)) : ui.readServer(url),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "POST")![1]!.body!);
    expect(body.redirectUris).toEqual([
      { type: "spa", uri: "http://localhost:3000/callback" },
      { type: "spa", uri: expected },
    ]);
    expect(ui.get("clientEditor").open).toBe(true);
    expect(ui.get("editorError").textContent).toContain("リダイレクト URI");
    expect(ui.rows()).toEqual(rows);
    expect(rows[1]!.querySelector("input")!.value).toBe(input);
  });
  it("starts with an unselected platform and one empty URI field", async () => {
    const ui = await setup();
    await ui.get("newClient").onclick!();
    expect(ui.get("platform").value).toBe("");
    expect(ui.rows()).toHaveLength(1);
    const input = ui.rows()[0]!.querySelector("input")!;
    expect(input.value).toBe("");
    expect(input.required).toBe(true);
    expect(ui.rows()[0]!.querySelector("button")!.disabled).toBe(true);
    expect(ui.get("platformMixedHint").classes.has("hidden")).toBe(true);
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    expect(ui.request).not.toHaveBeenCalled();
    expect(ui.get("platform").focus).toHaveBeenCalled();
    expect(ui.get("editorError").textContent).toContain("1つ選択");
  });
  it("switches the platform for all URIs without deleting their values", async () => {
    const ui = await setup();
    await ui.startClient();
    await ui.addUri();
    ui.rows()[1]!.querySelector("input")!.value = "https://app.example.test/logout";
    const values = ui.rows().map((row) => row.querySelector("input")!.value);
    ui.selectPlatform("native");
    expect(ui.rows().map((row) => row.querySelector("input")!.value)).toEqual(values);
    ui.request.mockImplementation(async (url, options) =>
      options?.method === "POST" ? parseCreateClient(JSON.parse(options.body!)) : ui.readServer(url),
    );
    await ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    const body = JSON.parse(ui.request.mock.calls.find(([, options]) => options?.method === "POST")![1]!.body!);
    expect(body.redirectUris).toEqual(values.map((uri) => ({ type: "native", uri })));
  });
  it("adds and deletes URI rows while retaining at least one row", async () => {
    const ui = await setup();
    await ui.startClient();
    await ui.addUri();
    const [original, added] = ui.rows();
    expect(added!.querySelector("input")!.value).toBe("");
    expect(added!.querySelector("input")!.focus).toHaveBeenCalled();
    await original!.querySelector("button")!.onclick!();
    expect(ui.rows()).toEqual([added]);
    expect(added!.querySelector("input")!.focus).toHaveBeenCalledTimes(2);
    expect(added!.querySelector("button")!.disabled).toBe(true);
    await added!.querySelector("button")!.onclick!();
    expect(ui.rows()).toHaveLength(1);
  });
  it("enforces the 256-URI limit and restores adding after deletion", async () => {
    const ui = await setup(),
      fixture = {
        ...client(),
        redirectUris: Array.from({ length: 256 }, (_, index) => ({
          type: "spa",
          uri: "https://app.example.test/callback/" + index,
        })),
      };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openClient(fixture)", ui.sandbox);
    expect(ui.get("addRedirectUri").disabled).toBe(true);
    expect(ui.get("platform").disabled).toBe(false);
    await ui.addUri();
    expect(ui.rows()).toHaveLength(256);
    await ui.rows()[255]!.querySelector("button")!.onclick!();
    expect(ui.get("addRedirectUri").disabled).toBe(false);
    expect(ui.rows()[254]!.querySelector("input")!.focus).toHaveBeenCalled();
    await ui.addUri();
    expect(ui.rows()).toHaveLength(256);
    expect(ui.get("addRedirectUri").disabled).toBe(true);
  });
  it.each(["add URI", "remove URI", "edit URI", "platform"])("detects unsaved edits: %s", async (change) => {
    const ui = await setup(),
      fixture = {
        ...client(),
        redirectUris: [
          { type: "spa", uri: "https://app.example.test/callback" },
          { type: "spa", uri: "https://app.example.test/logout" },
        ],
      };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openClient(fixture)", ui.sandbox);
    if (change === "add URI") await ui.addUri();
    if (change === "remove URI") await ui.rows()[0]!.querySelector("button")!.onclick!();
    if (change === "edit URI") ui.rows()[0]!.querySelector("input")!.value = "https://app.example.test/changed";
    if (change === "platform") ui.selectPlatform("native");
    ui.sandbox.confirm.mockReturnValue(false);
    await ui.get("cancelClient").onclick!();
    expect(ui.sandbox.confirm).toHaveBeenCalledWith("未保存の変更を破棄しますか？");
    expect(ui.get("clientEditor").open).toBe(true);
  });
  it("closes a new untouched form without a discard confirmation", async () => {
    const ui = await setup();
    await ui.get("newClient").onclick!();
    await ui.get("cancelClient").onclick!();
    expect(ui.sandbox.confirm).not.toHaveBeenCalled();
    expect(ui.get("clientEditor").open).toBe(false);
  });
  it.each([1, 256])("restores the platform and row limits after a failed save with %i URIs", async (count) => {
    const ui = await setup(),
      fixture = {
        ...client(),
        clientType: "CONFIDENTIAL",
        clientSecret: "test-secret",
        emailOptionalClaim: false,
        groupMembershipClaims: "None",
        redirectUris: Array.from({ length: count }, (_, index) => ({
          type: "web",
          uri: "https://app.example.test/callback/" + index,
        })),
      };
    Object.assign(ui.sandbox, { fixture });
    runInNewContext("openClient(fixture)", ui.sandbox);
    const row = ui.rows()[0]!;
    row.querySelector("input")!.value = " https://example.test/callback ";
    const pending = deferred<unknown>();
    ui.request.mockReturnValueOnce(pending.promise);
    const save = ui.get("clientForm").onsubmit!({ preventDefault: vi.fn() });
    expect(ui.get("platform").disabled).toBe(true);
    expect(ui.get("addRedirectUri").disabled).toBe(true);
    expect(row.querySelector("input")!.disabled).toBe(true);
    expect(row.querySelector("button")!.disabled).toBe(true);
    await ui.addUri();
    expect(ui.rows()).toHaveLength(count);
    pending.reject(new Error("保存できませんでした"));
    await save;
    expect(ui.get("clientEditor").open).toBe(true);
    expect(ui.get("platform").value).toBe("web");
    expect(ui.get("platform").disabled).toBe(false);
    expect(row.querySelector("input")!.value).toBe(" https://example.test/callback ");
    expect(ui.get("addRedirectUri").disabled).toBe(count === 256);
    expect(row.querySelector("input")!.disabled).toBe(false);
    expect(row.querySelector("button")!.disabled).toBe(count === 1);
    expect(ui.get("editorError").focus).toHaveBeenCalled();
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
    expect(ui.get("copyMessage").textContent).toContain("手動でコピー");
  });
  it("disables issuing for unavailable candidates and recovers using each list's retry", async () => {
    const ui = await setup();
    runInNewContext("setTokenChoices('client',[]);setTokenChoices('user',[]);", ui.sandbox);
    expect(ui.get("issueToken").disabled).toBe(true);
    ui.request.mockRejectedValue(new Error("connection failed"));
    await ui.reload();
    await vi.waitFor(() => expect(ui.get("tokenChoicesError").textContent).toContain("候補を読み込めませんでした"));
    expect(ui.get("issueToken").disabled).toBe(true);
    ui.request.mockImplementation(async (url) => (url.endsWith("clients") ? [client()] : [user()]));
    expect(ui.get("clientPanel").open).toBe(true);
    expect(ui.get("userPanel").open).toBe(true);
    expect(ui.get("tokenChoicesError").textContent).toContain("該当する一覧");
    await ui.get("retryClients").onclick!();
    await ui.get("retryUsers").onclick!();
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
      if (kind === "client") ui.openExistingClient();
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
