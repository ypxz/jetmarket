import { createMemoryRepo } from "../../lib/repo/memory";
import { repoContract } from "./repo.contract";

repoContract("memory", () => createMemoryRepo());
