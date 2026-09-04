# Server boundary

Server-only orchestration, authentication, public-response validation, safe
logging and MCP lifecycle belong here. Add import "server-only" to runtime
modules. HTTP placeholders authenticate separate gateway/manager bearer tokens
and return 501; they never invoke integrations. Missing configuration returns
503 and invalid credentials return 401. Host/Origin validation and real MCP
lifecycle remain Milestone 1 work. Manager session authentication remains an
App-integration decision; never ship the manager bearer token to a browser.
