import { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ArcBreaker } from "./arcBreaker";

const Dust = lazy(() => import("./dust").then((m) => ({ default: m.Dust })));

const game = import.meta.env.VITE_GAME;
const Root = game === "arc" ? ArcBreaker : game === "dust" ? Dust : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <Suspense fallback={<div style={{ color: "#cfe9ff", padding: 16, fontFamily: "system-ui" }}>loading…</div>}>
    <Root />
  </Suspense>,
);
