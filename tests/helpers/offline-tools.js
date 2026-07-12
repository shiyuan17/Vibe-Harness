import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.npm_config_cache = path.join(tmpdir(), `loopengine-test-empty-npm-cache-${process.pid}`);
process.env.npm_config_offline = 'true';
process.env.LOOPENGINE_TEST_OFFLINE = '1';
process.env.ANTHROPIC_API_KEY = '';
process.env.OCR_LLM_MODEL = '';
process.env.OCR_LLM_TOKEN = '';
process.env.OCR_LLM_URL = '';
process.env.OPENAI_API_KEY = '';
