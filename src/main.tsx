import ReactDOM from "react-dom/client";
import App from "./App";
import { ArcBreaker } from "./arcBreaker";

const game = import.meta.env.VITE_GAME;
const Root = game === "arc" ? ArcBreaker : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
