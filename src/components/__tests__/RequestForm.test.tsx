import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequestForm } from "../RequestForm";
import type { RequestSpec } from "../../bindings";

const base: RequestSpec = { method: "GET", url: "http://localhost:8787/", headers: [], body: null, bearer: null };

function Harness(props: { initial?: Partial<RequestSpec>; showAllErrors?: boolean }) {
  const [value, setValue] = useState<RequestSpec>({ ...base, ...props.initial });
  return <RequestForm value={value} onChange={setValue} showAllErrors={props.showAllErrors} />;
}

describe("RequestForm validation", () => {
  it("shows no errors for a valid request", () => {
    render(<Harness showAllErrors />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("flags an invalid URL after the field is touched", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const url = screen.getByLabelText("URL");
    await user.clear(url);
    await user.type(url, "not a url");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // not before blur
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid URL");
    expect(url).toHaveAttribute("aria-invalid", "true");
  });

  it("requires a URL and an http(s) scheme", async () => {
    const { unmount } = render(<Harness initial={{ url: "" }} showAllErrors />);
    expect(screen.getByRole("alert")).toHaveTextContent("URL is required");
    unmount();
    render(<Harness initial={{ url: "ftp://example.com" }} showAllErrors />);
    expect(screen.getByRole("alert")).toHaveTextContent("http:// or https://");
  });

  it("validates JSON bodies", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ method: "POST", body: { kind: "json", content: "" } }} />);
    const body = screen.getByLabelText("Request body");
    await user.type(body, '{{"a": ');
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid JSON");
    await user.clear(body);
    await user.type(body, '{{"a": 1}');
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("requires a header name for enabled headers, ignores disabled ones", async () => {
    const user = userEvent.setup();
    render(<Harness showAllErrors />);
    await user.click(screen.getByRole("button", { name: "+ Add header" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Header name is required");
    await user.click(screen.getByLabelText("Enable header 1"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("masks bearer tokens and sensitive header values", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ bearer: "s3cret", headers: [{ name: "Authorization", value: "Basic x", enabled: true }] }} />);
    expect(screen.getByLabelText("Bearer token")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Header 1 value")).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show Bearer token" }));
    expect(screen.getByLabelText("Bearer token")).toHaveAttribute("type", "text");
  });
});
