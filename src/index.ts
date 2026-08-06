#!/usr/bin/env node
/**
 * Entrypoint stdio: o Claude Desktop sobe este processo localmente e conversa
 * por stdin/stdout. É o modo de uso individual, com o token do Meta na própria
 * máquina. Para acesso compartilhado pela equipe, veja `http.ts`.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

// Sem bearer no stdio: quem controla o processo é quem tem o arquivo de
// ambiente, então META_ALLOW_WRITES sozinho decide.
const { allowWrites } = loadConfig();

serveStdio(() => createServer({ canWrite: allowWrites }));
