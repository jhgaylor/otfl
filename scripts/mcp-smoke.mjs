// Quick MCP client smoke test against a running OTFL server.
// Usage: node scripts/mcp-smoke.mjs http://localhost:8099/mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] || "http://localhost:8099/mcp";
const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const created = await client.callTool({
  name: "create_list",
  arguments: { title: "MCP test", items: ["a", "b"] },
});
const list = JSON.parse(created.content[0].text);
console.log("CREATED:", list.id, "share_url:", list.share_url, "items:", list.items.length);

const toggled = await client.callTool({
  name: "toggle_item",
  arguments: { list_id: list.id, item_id: list.items[0].id },
});
console.log("TOGGLED checked:", JSON.parse(toggled.content[0].text).checked);

const got = await client.callTool({ name: "get_list", arguments: { list_id: list.id } });
console.log("GET items:", JSON.parse(got.content[0].text).items.map((i) => `${i.text}:${i.checked}`).join(", "));

const missing = await client.callTool({ name: "get_list", arguments: { list_id: "nope" } });
console.log("MISSING isError:", missing.isError);

await client.callTool({ name: "delete_list", arguments: { list_id: list.id } });
console.log("DELETED ok");

await client.close();
