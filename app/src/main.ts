import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";

document.documentElement.dataset.mac = String(navigator.userAgent.includes("Mac"));
export default mount(App, { target: document.getElementById("app")! });
