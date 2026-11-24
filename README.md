# Gemini in Russia через Vercel — прокси с OpenAI-совместимым API

Готовый проект: маленькая serverless-функция на Vercel, которая принимает
запросы в формате OpenAI (`/v1/chat/completions`) и переводит их в Gemini API.
Работает чат, потоковая выдача (SSE) и **вызов инструментов (function calling)** —
то есть этой моделью можно пользоваться в DeepSeek Harness как полноценным агентом.

```
DSH  →  https://<ваш-домен>/v1/chat/completions  →  generativelanguage.googleapis.com
```

Зачем прокси: Google не отвечает на запросы из РФ (`User location is not supported`),
а Vercel — отвечает. Ключ Gemini живёт только в переменных окружения Vercel и никогда
не попадает клиенту.

---

## 0. Что понадобится

| Что | Зачем | Где взять |
|---|---|---|
| Аккаунт GitHub | хранить код проекта | github.com |
| Аккаунт Vercel | деплой | vercel.com |
| Ключ Gemini API | доступ к модели | aistudio.google.com/apikey (**нужен VPN один раз**, только чтобы получить ключ) |
| Домен (желательно) | `*.vercel.app` в РФ блокируется | см. раздел 6 |

Ключ Gemini после получения работает с серверов Vercel — VPN для самих запросов не нужен.

---

## 1. Структура проекта

```
gemini-vercel-proxy/
├─ api/v1/chat/completions.js   # вся логика: чат, стриминг, tools
├─ vercel.json                  # маршруты /v1/* и лимит времени функции
├─ package.json
├─ test-local.mjs               # офлайн-проверка маппинга (без сети и ключа)
└─ .env.example                 # список переменных
```

Локальная проверка логики (необязательно, но полезно):

```bash
node test-local.mjs      # печатает "OK: mapping, tools and streaming verified offline"
```

---

## 2. Деплой через GitHub (рекомендую)

1. Создайте на GitHub пустой репозиторий, например `gemini-vercel-proxy`
   (без README и .gitignore — они не нужны).
2. Загрузите туда файлы из этой папки (можно перетащить через веб-интерфейс
   GitHub → **Add file → Upload files**).
3. Откройте [vercel.com/new](https://vercel.com/new) → **Import Git Repository** →
   выберите репозиторий → **Import**.
4. На экране настройки:
   - **Framework Preset:** `Other`
   - **Root Directory:** оставьте пустым (корень репозитория)
   - **Build Command / Output Directory:** оставить пустыми
5. Раскройте **Environment Variables** и добавьте:

   | Имя | Значение | Обязательно |
   |---|---|---|
   | `GEMINI_API_KEY` | ключ `AQ...` или `AIza...` из AI Studio | **да** |
   | `DEFAULT_MODEL` | `gemini-3.1-flash-lite` (или `gemini-3.5-flash`) | нет |
   | `PROXY_TOKEN` | любой длинный пароль, например `sk-dsh-8f3a...` | настоятельно |
   | `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | нет |

6. Нажмите **Deploy** и дождитесь «Congratulations».

После деплоя вы получите адрес вида `https://gemini-vercel-proxy-xxxx.vercel.app`.

---

## 3. Деплой через Vercel CLI (если не хотите GitHub)

```bash
npm i -g vercel
cd gemini-vercel-proxy
vercel login
vercel            # первый деплой, отвечайте на вопросы (Framework: Other)
vercel env add GEMINI_API_KEY      # вставить ключ
vercel env add PROXY_TOKEN         # придумать пароль
vercel --prod                      # боевой деплой
```

---

## 4. Проверка, что всё работает

Замените `HOST` и `TOKEN` на свои значения (PowerShell):

```powershell
$HOST  = "https://gemini-vercel-proxy-xxxx.vercel.app"
$TOKEN = "sk-dsh-..."     # значение PROXY_TOKEN

# 1) список моделей
curl.exe -sS -H "Authorization: Bearer $TOKEN" "$HOST/v1/models"

# 2) простой чат
curl.exe -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" `
  -d '{\"model\":\"gemini-in-russia\",\"messages\":[{\"role\":\"user\",\"content\":\"Сколько будет 17*23? Ответь одним числом.\"}]}' `
  "$HOST/v1/chat/completions"
```

Ожидаемо: JSON с `choices[0].message.content` = «391» (или «триста девяносто один»).

3) Проверка **инструментов** (function calling):

```powershell
curl.exe -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" `
  -d '{\"model\":\"gemini-in-russia\",\"messages\":[{\"role\":\"user\",\"content\":\"Какая погода в Москве?\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"description\":\"Погода в городе\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}}]}' `
  "$HOST/v1/chat/completions"
```

В ответе должно появиться `"tool_calls":[{"function":{"name":"get_weather",...}}]`.
Если появилось — прокси годится для агентской работы в DSH.

---

## 5. Частые ошибки

| Симптом | Причина | Что делать |
|---|---|---|
| `401 invalid proxy token` | неверный/отсутствует `PROXY_TOKEN` | передайте `Authorization: Bearer <PROXY_TOKEN>` |
| `500 GEMINI_API_KEY is not configured` | переменная не задана | Vercel → Settings → Environment Variables, затем **Redeploy** |
| `502 ... 400 ... location is not supported` | запрос ушёл с российского IP | запросы должны идти через Vercel, а не с вашего ПК |
| `502 ... 429` | исчерпан бесплатный лимит Gemini | подождите или подключите платный ключ |
| `FUNCTION_INVOCATION_TIMEOUT` | ответ дольше лимита функции | Hobby: до 60 с (`maxDuration` в `vercel.json`), для долгих задач — Pro |
| `404 NOT_FOUND` на `/v1/...` | не сработал rewrite | проверьте, что `vercel.json` в корне и деплой пересобран |

---

## 6. Домен (важно для России)

`*.vercel.app` в РФ заблокирован: соединение просто не устанавливается.
Два варианта:

**A. Свой домен (правильный путь).**

1. Vercel → Project → **Settings → Domains → Add**.
2. Введите домен, например `gemini.example.ru`.
3. Vercel покажет запись: обычно `CNAME → cname.vercel-dns.com`.
4. Добавьте её у регистратора домена. Через 5–30 минут домен заработает,
   сертификат Vercel выпустит сам.
5. Используйте `https://gemini.example.ru/v1` — блокировки `*.vercel.app` больше нет.

**B. Обход без домена.** Запросы к `*.vercel.app` можно вести на рабочий edge-IP
(например `216.198.79.195`) с правильным SNI. Так делает локальный мост
`gemini-ru-bridge.py` из этой же настройки DSH. Минус: IP может смениться,
решение хрупкое — годится как временное.

---

## 7. Подключение к DeepSeek Harness

### Через интерфейс

**Настройки → Модели → Добавить провайдера → Custom model API**:

| Поле | Значение |
|---|---|
| Provider ID | `gemini-vercel` |
| Base URL | `https://gemini.example.ru/v1` |
| API-протокол | `openai-completions` |
| API-ключ | ваш `PROXY_TOKEN` |
| Модели | `gemini-in-russia` (или `gemini-3.1-flash-lite`) |

### Через конфиг профиля

`C:\Users\<user>\.dsh\profiles\desktop\cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      gemini-vercel:
        displayName: Gemini (Vercel)
        api: openai-completions
        baseURL: https://gemini.example.ru/v1
        apiKeyEnv: GEMINI_PROXY_TOKEN      # ключ храните в .dsh\.env
        models:
          - id: gemini-in-russia
            name: Gemini 3.1 Flash-Lite (Vercel)
            contextWindow: 1048576
            maxTokens: 65536
            input: [ text, image ]
```

и в `C:\Users\<user>\.dsh\.env`:

```
GEMINI_PROXY_TOKEN=sk-dsh-...
```

После сохранения — выбрать модель в списке. В отличие от вебхука для Алисы,
здесь работает и история диалога, и инструменты.

---

## 8. Безопасность

- Ключ Gemini хранится только в переменных Vercel; в DSH вы вводите `PROXY_TOKEN`.
- Обязательно задайте `PROXY_TOKEN`, иначе ваш прокси сможет использовать любой,
  кто узнает адрес (и тратить вашу квоту).
- Ротируйте ключ: AI Studio → удалить → создать новый → обновить `GEMINI_API_KEY`
  → **Redeploy**.
- Логи запросов в Vercel хранят только метаданные; тела запросов по умолчанию не пишутся.

---

## 9. Ограничения

- Бесплатный тариф Vercel: функция до 60 секунд, этого хватает на обычные ответы,
  но длинные «размышления» могут упереться в лимит.
- Бесплатный ключ Gemini ограничен по запросам в минуту и в сутки; при 429 —
  пауза или платный ключ.
- Прокси не хранит состояние: каждый запрос несёт всю историю в `messages`,
  как и положено OpenAI-совместимому API.
