import { newStep, newTest, groupItem } from "../defaults";
import { allSteps, duplicateStep, extractedBefore, insertItems, moveById, removeById, stepLabel } from "../flow";
import { namesFor, openPlaceholder, preview, tokenize } from "../template";
import { parseCurl, shellWords } from "../curl";

describe("flow editing", () => {
  const base = () => {
    const t = newTest("http://localhost/a");
    const login = newStep("http://localhost/login", "POST");
    login.extract.push({ id: "x", var: "token", source: "json", expr: "$.token", pick: "first", index: 0, default: "", on_missing: "skip_iteration", secret: true, enabled: true });
    t.setup.push(login);
    return { t, login };
  };
  it("lists steps in run order and edits them immutably", () => {
    const { t, login } = base();
    const sc = t.scenarios[0]!;
    const t2 = insertItems(t, { scenario: sc.id, list: "steps" }, [groupItem("http://localhost/g")]);
    const ids = allSteps(t2).map((r) => r.phase);
    expect(ids).toEqual(["setup", "main", "main", "main"]);
    const first = allSteps(t2)[1]!.step.id;
    const [t3, copy] = duplicateStep(t2, first);
    expect(allSteps(t3)[2]!.step.id).toBe(copy);
    const t4 = moveById(t3, copy, -1);
    expect(allSteps(t4)[1]!.step.id).toBe(copy);
    const t5 = removeById(t4, login.id);
    expect(t5.setup).toHaveLength(0);
    expect(t.setup).toHaveLength(1);
  });
  it("knows which extracted values a step can read", () => {
    const { t } = base();
    const step = allSteps(t)[1]!.step;
    expect(extractedBefore(t, step.id).map((e) => e.name)).toEqual(["token"]);
    expect(namesFor(t, step.id).some((n) => n.name === "token" && n.source === "extract")).toBe(true);
    expect(stepLabel(newStep("https://api.test/users/{{id}}"))).toBe("GET /users/{{id}}");
  });
});

describe("templates", () => {
  it("tokenizes variables, generators and mistakes", () => {
    expect(tokenize("{{baseUrl}}/u/{{$randomInt(1, 9)}}?x={{bad name}}").map((t) => t.kind)).toEqual(["var", "lit", "gen", "lit", "bad"]);
    expect(tokenize("\\{{literal}}")).toEqual([{ kind: "lit", text: "\\{{literal}}" }]);
    expect(tokenize("{{$nope}}")[0]!.kind).toBe("bad");
  });
  it("previews with values, pending extracts and missing names", () => {
    const vars = new Map([["baseUrl", "http://x"]]);
    const pending = new Map([["token", "from Login"]]);
    const r = preview("{{baseUrl}}/{{token}}/{{nope}}/{{$upper({{baseUrl}})}}", { vars, pending, secrets: new Set() });
    expect(r.map((p) => p.kind)).toEqual(["value", "lit", "pending", "lit", "missing", "lit", "value"]);
    expect(r[6]!.text).toBe("HTTP://X");
  });
  it("finds the placeholder being typed", () => {
    expect(openPlaceholder("http://{{bas", 12)).toEqual([7, "bas"]);
    expect(openPlaceholder("{{done}} x", 10)).toBeNull();
    expect(openPlaceholder("{{$rand", 7)).toEqual([0, "$rand"]);
  });
});

describe("cURL import", () => {
  it("splits shell words like a shell", () => {
    expect(shellWords(`curl -H 'A: b c' "x\\"y" $'n\\nl' \\\n  next`)).toEqual(["curl", "-H", "A: b c", 'x"y', "n\nl", "next"]);
  });
  it("turns a browser's Copy as cURL into a step", () => {
    const r = parseCurl(`curl 'https://api.shop.test/login?src=web' -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' --data-raw '{"user":"ada"}' --compressed -k`);
    if ("error" in r) throw new Error(r.error);
    const s = r.step;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("https://api.shop.test/login");
    expect(s.params).toEqual([{ name: "src", value: "web", enabled: true }]);
    expect(s.auth).toEqual({ kind: "bearer", token: "abc" });
    expect(s.body?.kind).toBe("json");
    expect(s.body?.content).toContain('"user": "ada"');
    expect(s.headers).toEqual([]);
    expect(r.ignored.join()).toContain("-k");
  });
  it("handles forms, basic auth and missing URLs", () => {
    const r = parseCurl("curl -u ada:pw -d 'a=1&b=two+words' http://localhost:8787/form");
    if ("error" in r) throw new Error(r.error);
    expect(r.step.auth).toEqual({ kind: "basic", username: "ada", password: "pw" });
    expect(r.step.body?.kind).toBe("form");
    expect(r.step.body?.fields.map((f) => [f.name, f.value])).toEqual([["a", "1"], ["b", "two words"]]);
    expect("error" in parseCurl("curl -X GET")).toBe(true);
    expect("error" in parseCurl("wget x")).toBe(true);
  });
});
