import { render } from "preact";
import { App } from "./app";
import "./styles.css";

// Public booking uses only local fonts; retain the existing platform typography elsewhere.
if (!/^\/book\/[a-z0-9-]+\/?$/.test(window.location.pathname)) {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
  document.head.append(stylesheet);
}

render(<App />, document.getElementById("app")!);
