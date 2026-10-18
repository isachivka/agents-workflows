// Everything the UI says, in English and Russian, and the rules that turn a run's state into
// words. Pure — no DOM, no fetch — so node:test loads it directly (test/ui-text.test.ts).
// Author-written text (step summaries, prompts, notes, reasons) is shown as written.

export const LANGS = ["en", "ru"];

const EN = {
  "nav.now": "Now", "nav.processes": "Processes", "nav.settings": "Settings", "nav.label": "Sections", "lang.label": "Language",
  "title.waiting": "({n}) Waiting for you · flows", "title.page": "{page} · flows", "loading": "Loading…",
  "st.queued": "Queued", "tag.queued": "In line", "run.queued": "{n} in line: {open} of {max} runs are working", "st.running": "Running", "st.paused": "Paused", "st.needs-human": "Waiting for you", "st.done": "Finished", "st.stopped": "Stopped",
  "tag.yourStep": "Your step", "tag.stopped": "Stopped", "tag.agentAsks": "Agent asks", "tag.working": "Agent working",
  "tag.agentWaits": "Agent waits", "tag.roundDone": "Round done", "tag.waiting": "Waiting",
  "tag.nest": "Choose what runs inside", "nest.title": "It reached the place where another process runs on agent {role}. Choose it, or skip this step.",
  "nest.pick": "Process inside", "nest.start": "Start on agent {role}", "nest.skip": "Skip", "nest.skipNote": "no nested process",
  "stack.under": "under it", "stack.bottom": "at the bottom", "stack.then": "then: {step}", "stack.onTop": "on top of", "stack.waits": "it waits for this one to end",
  "inner.runs": "Inside runs", "inner.agentOn": "Agent {role} works on it now. {run} does nothing and goes on by itself once it ends.",
  "inner.stop": "Stop {run}", "why.stopChild": "this step fails, then you decide", "inner.noSkip": "Skipping is possible once nothing runs inside.",
  "agent.busyWith": "busy with {run}", "after.title": "When it ends", "after.goesOn": "{run} goes on", "after.back": "Goes back up",
  "after.nothingBack": "nothing yet", "after.stop": "If you stop it", "after.stopText": "the step of {run} fails; you decide there",
  "run.label": "{process} · run {n}", "run.round": "round {n}", "run.started": "started {when}",
  "run.finished": "Finished", "run.stopped": "Stopped by you", "run.stepFailed": "Step “{step}” did not work out",
  "run.stoppedForYou": "The run stopped and waits for you", "run.closesBy": "Closes by itself once {what} arrives",
  "run.agentWaitsForYou": "{role} waits for you", "run.agentWaitNote": "waiting: {note}", "run.starting": "Starting",
  "You": "You", "someone": "Someone",
  "dur.lt1m": "less than a minute", "dur.m": "{m} min", "dur.h": "{h} h", "dur.hm": "{h} h {m} min", "dur.d": "{d} d", "ago": "{d} ago",
  "ev.gh.checks": "GitHub checks", "ev.gh.merged": "the PR merge", "ev.gh.review": "a PR review", "ev.gh.opened": "the PR opening",
  "ev.gh.ci": "GitHub CI", "ev.signal": "signal {name}", "wait.for": "Waiting for {what}", "wait.pause": "Pause {d}", "inner.wait": "Waits for a nested process", "inner.child": "Nested: {run}", "do.sh": "flows runs {cmd}", "wait.until": "Pause until {when}", "wait.hold": "Waits for {hold}: {run} has it", "wait.holdFree": "Waits for {hold}",
  "do.clear": "{role} starts fresh", "do.compact": "{role} compacts its context", "do.type": "flows types into {role}'s terminal",
  "do.plugin": "Action {name}",
  "evs.delivered": "{role} got the task", "evs.done": "{role} finished", "evs.doneNote": "{role} finished: “{note}”",
  "evs.failed": "{role} failed", "evs.failedNote": "{role} failed: “{note}”", "evs.set": "Run details updated",
  "evs.start": "The run started", "evs.round": "Round {n} finished", "evs.plugin": "{what}: {outcome}",
  "outcome.done": "ok", "outcome.failed": "failed",
  "now.title": "Now", "now.lead.calm": "Everything is calm.",
  "now.lead.waiting.one": "One run waits for you.", "now.lead.waiting.other": "{n} runs wait for you.",
  "now.lead.more.one": "One more works on its own — no need to look.", "now.lead.more.other": "{n} more work on their own — no need to look.",
  "now.lead.working.one": "One run works on its own — nothing needs you.", "now.lead.working.other": "{n} runs work on their own — nothing needs you.",
  "now.start": "Start a process…", "now.waiting": "Waiting for you", "now.working": "Working on their own",
  "now.finished": "Finished today", "now.recent": "Finished lately", "now.older": "Show older", "now.noneToday": "Nothing finished today.", "now.empty": "Nothing has run yet.",
  "now.waitedFor": "waiting {d}", "now.stepOf": "Step {i} of {n}",
  "act.details": "Details", "act.terminal": "Agent terminal", "act.openTerminalOf": "Open {role}'s terminal",
  "act.openPr": "Open the PR on GitHub", "act.openSlack": "Slack thread", "act.sortOut": "Sort it out", "act.sortYourself": "Look yourself",
  "act.retry": "Try again", "act.skip": "Skip this step", "act.done": "Done", "act.markDone": "Mark the step finished",
  "act.goto": "Jump to step…", "act.go": "Apply", "act.rebind": "Hand to another terminal…", "act.respawn": "Restart the agent",
  "act.restore": "Restore session", "act.restoreOf": "Restore {role}", "why.restore": "Open the agent's Claude conversation again in a new agterm session",
  "act.ping": "Ping", "act.pinged": "Agent asked to ping", "why.ping": "Ask the agent to nudge whoever this run is waiting on",
  "act.pause": "Pause", "act.resume": "Resume", "act.stop": "Stop", "act.stopRun": "Stop the run for good", "act.start": "Start",
  "act.edit": "Edit", "act.editText": "Edit text", "act.cancel": "Cancel", "act.create": "Create",
  "why.retry": "The agent gets the task again. Right when the cause is already gone.",
  "why.skip": "The run moves on without this step.",
  "why.terminal": "Talk to the agent directly, then come back here and choose.",
  "why.respawn": "Opens a fresh terminal for the agent and gives it the task again.",
  "why.markDone": "The run moves on as if the agent had reported.", "why.restart": "The agent gets the task once more.",
  "skip.reason": "Why skip it?", "confirm.respawn": "Restart {role}? It gets a fresh terminal and the task again; what it was doing in the old one is lost.", "confirm.stop": "Stop {run}? The agents' terminals stay open.",
  "run.howItGoes": "How it goes", "run.details": "Run details", "run.agents": "Agents", "run.agentMore": "More",
  "run.happened": "What happened", "run.fullHistory": "Full history with technical details", "run.noDetails": "Nothing yet",
  "run.nothingYet": "Nothing yet", "run.now": "Now", "run.running": "running {d}", "run.attempt": "attempt {n}",
  "run.toldAgent": "What the agent was told", "run.stepIn": "Step in by hand", "run.startAgain": "Start the step again",
  "run.otherOptions": "Other options", "run.whatToDo": "What now?",
  "run.noSession": "no terminal yet — one opens on its next step", "run.onlyIfNeeded": "only when needed", "run.skipped": "skipped",
  "run.agentSilent": "The agent has not reported yet. It will when it is done, and the run calls you if something goes wrong.",
  "run.howProcess": "How the process works",
  "sess.active": "working", "sess.completed": "free", "sess.idle": "free", "sess.blocked": "asks for permission",
  "sess.closed": "closed", "sess.unknown": "unknown",
  "branch.back": "If it fails → back to “{step}”", "branch.goto": "If it fails → “{step}”",
  "branch.retry": "If it fails → it tries again", "branch.end": "If it fails → nothing to do, it ends here", "branch.after": "Then → “{step}”",
  "proc.all": "All processes", "proc.repeat": "Repeats in rounds", "proc.oneRun": "One run at a time",
  "proc.maxRuns.one": "Up to {n} run at once", "proc.maxRuns.other": "Up to {n} runs at once",
  "proc.manual": "Started by hand", "proc.trigger": "Starts by itself on {what}", "proc.cron": "Starts on schedule {cron}",
  "proc.cwd": "Works in {cwd}", "proc.openRuns": "Running now", "proc.who": "Who takes part", "proc.agent": "agent",
  "proc.youDo": "does the human steps", "proc.how": "How it goes", "proc.again": "Then it starts again with a new round.",
  "proc.usedIn": "Also used in: {list}.", "proc.usedNowhere": "Used only here.",
  "proc.steps.one": "{n} step", "proc.steps.other": "{n} steps", "proc.new": "New process",
  "proc.invalid": "This process has errors and cannot start:", "proc.triggerErrors": "Its automatic starts do not work:", "proc.told": "What the agent is told",
  "proc.toldHuman": "What is asked of you", "proc.missing": "There is no process {name}.",
  "procs.lead": "What your agents can do. Open a process to see how it goes.", "procs.empty": "No processes yet.",
  "start.title": "Start {name}", "start.newTerminal": "Open a new terminal (recommended)", "start.who": "Terminal for {role}",
  "set.title": "Settings", "set.language": "Language", "set.steps": "Steps", "set.allSteps": "All steps of all processes",
  "set.plugins": "Plugins", "set.coreEvents": "Built-in events", "set.adhoc": "Your own events: signal.* (sent with flow signal).",
  "set.plugin": "plugin", "set.events": "events", "set.actions": "actions", "set.watching": "watching",
  "set.lastError": "last error", "set.trigger": "trigger", "set.service": "Service", "set.restart": "Restart flows",
  "set.restartConfirm": "Restart flows? Runs carry on after the restart.",
  "tech.when": "when", "tech.type": "type", "tech.step": "step", "tech.outcome": "outcome", "tech.data": "data",
  "badge.startsOn": "First waits for {what}", "badge.closesOn": "Closes itself on {what}", "badge.holds": "Holds {hold}",
  "badge.timeout": "At most {d}", "badge.tries.one": "Up to {n} try", "badge.tries.other": "Up to {n} tries",
  "agent.claude": "Claude agent", "agent.codex": "Codex agent", "agent.generic": "a program",
  "role.beside": "in the right half beside {role}", "role.cwd": "works in {cwd}",
  "fact.who": "Who", "fact.does": "Does", "fact.runs": "Runs", "fact.where": "Where", "fact.args": "With",
  "fact.startsOn": "Starts on", "fact.closesOn": "Closes itself on", "fact.cond": "Conditions", "fact.holds": "Holds",
  "fact.holdsV": "{hold} — while it runs, other runs wait their turn here", "fact.timeout": "At most", "fact.skills": "Skills",
  "fact.tries": "Tries", "fact.ifFails": "If it fails", "fact.asksYou": "asks you what to do",
  "fact.flows": "flows itself, no agent", "fact.procFolder": "the process folder", "fact.nested": "a nested process",
  "does.inner": "Here agent {role} runs another whole process, and this one waits until it ends. Which one is chosen when the run starts (flow start --inner) or here, when the run gets to it.",
  "does.pause": "nothing: waits {d}, then goes on by itself", "does.wait": "waits for {what}; how it ends closes the step",
  "does.type": "types into {role}: {text}", "does.typeNothing": "starts {role} and types nothing: it waits to be spoken to",
};

const RU = {
  "nav.now": "Сейчас", "nav.processes": "Процессы", "nav.settings": "Настройки", "nav.label": "Разделы", "lang.label": "Язык",
  "title.waiting": "({n}) Ждут тебя · flows", "title.page": "{page} · flows", "loading": "Загрузка…",
  "st.queued": "В очереди", "tag.queued": "В очереди", "run.queued": "В очереди №{n}: работают {open} из {max}", "st.running": "Работает", "st.paused": "На паузе", "st.needs-human": "Ждёт тебя", "st.done": "Готово", "st.stopped": "Остановлен",
  "tag.yourStep": "Твой шаг", "tag.stopped": "Остановился", "tag.agentAsks": "Агент просит", "tag.working": "Агент работает",
  "tag.agentWaits": "Агент ждёт", "tag.roundDone": "Круг готов", "tag.waiting": "Ждёт",
  "tag.nest": "Выбери, что делать внутри", "nest.title": "Дошёл до места, где на агенте {role} работает другой процесс. Выбери его или пропусти шаг.",
  "nest.pick": "Процесс внутри", "nest.start": "Запустить на агенте {role}", "nest.skip": "Пропустить", "nest.skipNote": "без вложенного процесса",
  "stack.under": "под ним", "stack.bottom": "в самом низу", "stack.then": "потом: {step}", "stack.onTop": "лежит поверх", "stack.waits": "он ждёт, пока этот закончится",
  "inner.runs": "Внутри работает", "inner.agentOn": "Агент {role} сейчас на нём. {run} ничего не делает и пойдёт дальше сам, когда тот закончится.",
  "inner.stop": "Остановить {run}", "why.stopChild": "этот шаг не получится — дальше решаешь ты", "inner.noSkip": "Пропустить шаг можно, только когда внутри ничего не идёт.",
  "agent.busyWith": "занят {run}", "after.title": "Когда закончится", "after.goesOn": "{run} продолжит", "after.back": "Наверх вернётся",
  "after.nothingBack": "пока ничего", "after.stop": "Если остановить", "after.stopText": "шаг {run} не получится, решать будешь там",
  "run.label": "{process} · запуск {n}", "run.round": "круг {n}", "run.started": "начат {when}",
  "run.finished": "Готово", "run.stopped": "Остановлен тобой", "run.stepFailed": "Шаг «{step}» не получился",
  "run.stoppedForYou": "Процесс остановился и ждёт тебя", "run.closesBy": "Закроется сам, когда дождёмся: {what}",
  "run.agentWaitsForYou": "{role} ждёт тебя", "run.agentWaitNote": "ждёт: {note}", "run.starting": "Запускается",
  "You": "Ты", "someone": "Кто-то",
  "dur.lt1m": "меньше минуты", "dur.m": "{m} мин", "dur.h": "{h} ч", "dur.hm": "{h} ч {m} мин", "dur.d": "{d} дн", "ago": "{d} назад",
  "ev.gh.checks": "проверки GitHub", "ev.gh.merged": "мёрдж PR", "ev.gh.review": "ревью PR", "ev.gh.opened": "открытие PR",
  "ev.gh.ci": "CI на GitHub", "ev.signal": "сигнал {name}", "wait.for": "Ждём: {what}", "wait.pause": "Пауза {d}", "inner.wait": "Ждёт вложенный процесс", "inner.child": "Вложенный: {run}", "do.sh": "flows выполняет {cmd}", "wait.until": "Пауза до {when}", "wait.hold": "Ждёт {hold}: сейчас занят {run}", "wait.holdFree": "Ждёт {hold}",
  "do.clear": "{role} начинает с чистого листа", "do.compact": "{role} сжимает контекст", "do.type": "flows печатает в терминал {role}",
  "do.plugin": "Действие {name}",
  "evs.delivered": "{role} получил задание", "evs.done": "{role} закончил", "evs.doneNote": "{role} закончил: «{note}»",
  "evs.failed": "{role} не справился", "evs.failedNote": "{role} не справился: «{note}»", "evs.set": "Данные запуска обновились",
  "evs.start": "Запуск начался", "evs.round": "Круг {n} закончился", "evs.plugin": "{what}: {outcome}",
  "outcome.done": "успешно", "outcome.failed": "не прошло",
  "now.title": "Сейчас", "now.lead.calm": "Всё спокойно.",
  "now.lead.waiting.one": "{n} запуск ждёт тебя.", "now.lead.waiting.few": "{n} запуска ждут тебя.",
  "now.lead.waiting.many": "{n} запусков ждут тебя.", "now.lead.waiting.other": "{n} запуска ждут тебя.",
  "now.lead.more.one": "Ещё {n} работает сам — туда можно не смотреть.", "now.lead.more.few": "Ещё {n} работают сами — туда можно не смотреть.",
  "now.lead.more.many": "Ещё {n} работают сами — туда можно не смотреть.", "now.lead.more.other": "Ещё {n} работают сами — туда можно не смотреть.",
  "now.lead.working.one": "{n} запуск работает сам — ты сейчас не нужен.", "now.lead.working.few": "{n} запуска работают сами — ты сейчас не нужен.",
  "now.lead.working.many": "{n} запусков работают сами — ты сейчас не нужен.", "now.lead.working.other": "{n} запуска работают сами — ты сейчас не нужен.",
  "now.start": "Запустить процесс…", "now.waiting": "Ждут тебя", "now.working": "Работают сами",
  "now.finished": "Сегодня закончились", "now.recent": "Недавно закончились", "now.older": "Показать раньше", "now.noneToday": "Сегодня ничего не закончилось.",
  "now.empty": "Пока ничего не запускалось.", "now.waitedFor": "ждёт {d}", "now.stepOf": "Шаг {i} из {n}",
  "act.details": "Подробнее", "act.terminal": "Терминал агента", "act.openTerminalOf": "Открыть терминал {role}",
  "act.openPr": "Открыть PR на GitHub", "act.openSlack": "Slack-тред", "act.sortOut": "Разобраться", "act.sortYourself": "Разобраться самому",
  "act.retry": "Попробовать снова", "act.skip": "Пропустить шаг", "act.done": "Готово", "act.markDone": "Считать шаг сделанным",
  "act.goto": "Перейти к шагу…", "act.go": "Применить", "act.rebind": "Поручить другому терминалу…", "act.respawn": "Перезапустить агента",
  "act.restore": "Восстановить сессию", "act.restoreOf": "Восстановить {role}", "why.restore": "Открыть разговор агента с Claude заново в новой сессии agterm",
  "act.ping": "Пингануть", "act.pinged": "Агент пингует", "why.ping": "Попросить агента пингануть того, на ком висит задача",
  "act.pause": "Пауза", "act.resume": "Продолжить", "act.stop": "Остановить", "act.stopRun": "Остановить запуск совсем",
  "act.start": "Запустить", "act.edit": "Изменить", "act.editText": "Изменить текст", "act.cancel": "Отмена", "act.create": "Создать",
  "why.retry": "Агент получит задание заново. Подходит, если причину уже убрали.",
  "why.skip": "Процесс пойдёт дальше без этого шага.",
  "why.terminal": "Поговори с агентом напрямую, потом вернись сюда и выбери, что дальше.",
  "why.respawn": "Откроет агенту новый терминал и даст задание заново.",
  "why.markDone": "Процесс пойдёт дальше, как будто агент отчитался.", "why.restart": "Агент получит задание ещё раз.",
  "skip.reason": "Почему пропускаешь?", "confirm.respawn": "Перезапустить {role}? Агент получит новый терминал и задание заново; то, что он делал в старом, пропадёт.", "confirm.stop": "Остановить {run}? Терминалы агентов останутся открытыми.",
  "run.howItGoes": "Как идёт", "run.details": "Данные запуска", "run.agents": "Агенты", "run.agentMore": "Ещё",
  "run.happened": "Что происходило", "run.fullHistory": "Вся история с техническими подробностями", "run.noDetails": "Пока пусто",
  "run.nothingYet": "Пока ничего", "run.now": "Сейчас", "run.running": "идёт {d}", "run.attempt": "попытка {n}",
  "run.toldAgent": "Что поручено агенту", "run.stepIn": "Вмешаться вручную", "run.startAgain": "Начать шаг заново",
  "run.otherOptions": "Другие варианты", "run.whatToDo": "Что сделать?",
  "run.noSession": "терминала пока нет — он откроется на следующем шаге", "run.onlyIfNeeded": "только если нужно", "run.skipped": "пропущен",
  "run.agentSilent": "Агент ещё не отчитывался. Он сообщит, когда закончит, а если что-то пойдёт не так — процесс позовёт тебя.",
  "run.howProcess": "Как устроен процесс",
  "sess.active": "работает", "sess.completed": "свободен", "sess.idle": "свободен", "sess.blocked": "ждёт разрешения",
  "sess.closed": "закрыт", "sess.unknown": "неизвестно",
  "branch.back": "Не получилось → обратно к «{step}»", "branch.goto": "Не получилось → «{step}»",
  "branch.retry": "Не получилось → пробует снова", "branch.end": "Не получилось → делать нечего, на этом всё", "branch.after": "Потом → «{step}»",
  "proc.all": "Все процессы", "proc.repeat": "Повторяется по кругу", "proc.oneRun": "Один запуск за раз",
  "proc.maxRuns.one": "До {n} запуска одновременно", "proc.maxRuns.few": "До {n} запусков одновременно",
  "proc.maxRuns.many": "До {n} запусков одновременно", "proc.maxRuns.other": "До {n} запуска одновременно",
  "proc.manual": "Запускаешь ты вручную", "proc.trigger": "Запускается сам: {what}", "proc.cron": "Запускается по расписанию {cron}",
  "proc.cwd": "Работает в {cwd}", "proc.openRuns": "Сейчас идут", "proc.who": "Кто участвует", "proc.agent": "агент",
  "proc.youDo": "делаешь шаги человека", "proc.how": "Как он идёт", "proc.again": "Потом всё начинается заново — новый круг.",
  "proc.usedIn": "Ещё используется в: {list}.", "proc.usedNowhere": "Больше нигде не используется.",
  "proc.steps.one": "{n} шаг", "proc.steps.few": "{n} шага", "proc.steps.many": "{n} шагов", "proc.steps.other": "{n} шага",
  "proc.new": "Новый процесс", "proc.invalid": "В процессе ошибки, запустить его нельзя:", "proc.triggerErrors": "Автозапуск не работает:", "proc.told": "Что поручено агенту",
  "proc.toldHuman": "Что нужно от тебя", "proc.missing": "Процесса {name} нет.",
  "procs.lead": "Что умеют делать твои агенты. Открой процесс, чтобы увидеть, как он идёт.", "procs.empty": "Процессов пока нет.",
  "start.title": "Запустить {name}", "start.newTerminal": "Открыть новый терминал (рекомендуется)", "start.who": "Терминал для {role}",
  "set.title": "Настройки", "set.language": "Язык", "set.steps": "Шаги", "set.allSteps": "Все шаги всех процессов",
  "set.plugins": "Плагины", "set.coreEvents": "Встроенные события", "set.adhoc": "Свои события: signal.* (отправляются через flow signal).",
  "set.plugin": "плагин", "set.events": "события", "set.actions": "действия", "set.watching": "следит за",
  "set.lastError": "последняя ошибка", "set.trigger": "запуск", "set.service": "Сервис", "set.restart": "Перезапустить flows",
  "set.restartConfirm": "Перезапустить flows? Запуски продолжатся после перезапуска.",
  "tech.when": "когда", "tech.type": "тип", "tech.step": "шаг", "tech.outcome": "итог", "tech.data": "данные",
  "badge.startsOn": "Сначала ждёт: {what}", "badge.closesOn": "Закроется сам: {what}", "badge.holds": "Занимает {hold}",
  "badge.timeout": "Не дольше {d}", "badge.tries.one": "До {n} попытки", "badge.tries.few": "До {n} попыток",
  "badge.tries.many": "До {n} попыток", "badge.tries.other": "До {n} попытки",
  "agent.claude": "агент Claude", "agent.codex": "агент Codex", "agent.generic": "программа",
  "role.beside": "в правой половине рядом с {role}", "role.cwd": "работает в {cwd}",
  "fact.who": "Кто делает", "fact.does": "Что делает", "fact.runs": "Выполняет", "fact.where": "Где", "fact.args": "С параметрами",
  "fact.startsOn": "Сначала ждёт", "fact.closesOn": "Закроется сам по событию", "fact.cond": "Условия", "fact.holds": "Занимает",
  "fact.holdsV": "{hold} — пока шаг идёт, другие запуски ждут здесь своей очереди", "fact.timeout": "Не дольше", "fact.skills": "Навыки",
  "fact.tries": "Попытки", "fact.ifFails": "Если не получилось", "fact.asksYou": "спросит тебя, что делать",
  "fact.flows": "flows сам, без агента", "fact.procFolder": "папка процесса", "fact.nested": "вложенный процесс",
  "does.inner": "Здесь агент {role} целиком проходит другой процесс, а этот ждёт, пока тот закончится. Какой — выбирают при запуске (flow start --inner) или здесь же, когда запуск дойдёт до этого места.",
  "does.pause": "ничего: ждёт {d} и идёт дальше сам", "does.wait": "ждёт: {what}; чем это кончится, тем и закроется шаг",
  "does.type": "печатает в {role}: {text}", "does.typeNothing": "запускает {role} и ничего не печатает: он ждёт, пока к нему обратятся",
};

export const DICT = { en: EN, ru: RU };

let lang = "en";
export function setLang(l) { lang = LANGS.includes(l) ? l : "en"; }
export function getLang() { return lang; }
/** `ru*` browsers get Russian, everyone else English. */
export function defaultLang(navLang) { return /^ru\b/i.test(navLang || "") ? "ru" : "en"; }

export function t(key, params = {}) {
  const s = DICT[lang][key] ?? DICT.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}

/** A counted phrase: `key.one`, `key.few`, … chosen by the language's plural rules. */
export function tn(key, n, params = {}) {
  const form = new Intl.PluralRules(lang).select(n);
  return t(DICT[lang][`${key}.${form}`] !== undefined ? `${key}.${form}` : `${key}.other`, { n, ...params });
}

export function duration(ms) {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return t("dur.lt1m");
  if (min < 60) return t("dur.m", { m: min });
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? t("dur.hm", { h, m: min % 60 }) : t("dur.h", { h });
  return t("dur.d", { d: Math.floor(h / 24) });
}
export const ago = (ts, now) => t("ago", { d: duration(now - ts) });
export const clock = (ts) => new Date(ts).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
/** Time of day for today, date and time before that. */
export function moment(ts, now) {
  return new Date(ts).toDateString() === new Date(now).toDateString()
    ? clock(ts)
    : new Date(ts).toLocaleString(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** `pr-loop#4` → "pr-loop · run 4" */
export function runLabel(id) {
  const i = id.lastIndexOf("#");
  return i < 0 ? id : t("run.label", { process: id.slice(0, i), n: id.slice(i + 1) });
}

const KNOWN_EVENTS = ["gh.checks", "gh.merged", "gh.review", "gh.opened", "gh.ci"];
export function eventPhrase(type) {
  if (KNOWN_EVENTS.includes(type)) return t(`ev.${type}`);
  if (type.startsWith("signal.")) return t("ev.signal", { name: type.slice(7) });
  return type;
}

const roleName = (role) => (role === "human" ? t("You") : role);

export function entryPhrase(e) {
  if (e.kind === "wait") return t("wait.for", { what: eventPhrase(e.waitFor || "") });
  if (e.kind === "delay") return t("wait.pause", { d: duration(e.waitMs || 0) });
  if (e.kind === "inner") return e.child ? t("inner.child", { run: runLabel(e.child) }) : t("inner.wait");
  if (e.kind === "action" && e.sh) return t("do.sh", { cmd: e.sh.length > 60 ? `${e.sh.slice(0, 57)}…` : e.sh });
  if (e.kind === "action") return ["clear", "compact", "type"].includes(e.do) ? t(`do.${e.do}`, { role: e.role }) : t("do.plugin", { name: e.do });
  return e.summary || e.step || e.id;
}

/** Where an entry leads besides "next": its failure route and its explicit jump. */
export function entryBranch(e, plan) {
  const num = (id) => plan.findIndex((x) => x.id === id) + 1;
  const name = (id) => entryPhrase(plan.find((x) => x.id === id));
  const out = [];
  if (e.onFail === "retry") out.push(t("branch.retry"));
  if (e.onFail === "end") out.push(t("branch.end"));
  else if (e.onFail && typeof e.onFail === "object") {
    out.push(t(num(e.onFail.goto) < num(e.id) ? "branch.back" : "branch.goto", { step: name(e.onFail.goto) }));
  }
  if (e.after) out.push(t("branch.after", { step: name(e.after.goto) }));
  return out;
}

/** The short badges on a process entry's card: what it waits for, what it holds, its limits. A pure
 * wait says what it waits for in its own phrase. */
export function entryBadges(e) {
  const out = [];
  if (e.waitFor && e.kind !== "wait") out.push({ tone: "wait", text: t(e.kind === "human" ? "badge.closesOn" : "badge.startsOn", { what: eventPhrase(e.waitFor) }) });
  if (e.hold) out.push({ tone: "hold", text: t("badge.holds", { hold: e.hold }) });
  if (e.timeoutMs) out.push({ tone: "lim", text: t("badge.timeout", { d: duration(e.timeoutMs) }) });
  if (e.onFail === "retry" && (e.kind === "agent" || e.kind === "action")) out.push({ tone: "lim", text: tn("badge.tries", e.retries) });
  return out;
}

export const agentName = (agent) => t(`agent.${agent === "claude" || agent === "codex" ? agent : "generic"}`);
const roleDef = (role, roleDefs) => (roleDefs || []).find((r) => r.name === role) || null;

/** Under a role's name on a process page: which agent, where it runs. */
export function roleLine(rd) {
  return [agentName(rd.agent), rd.beside ? t("role.beside", { role: rd.beside }) : "", rd.cwd ? t("role.cwd", { cwd: rd.cwd }) : ""]
    .filter(Boolean).join(" · ");
}

/** The small line above an entry's title in the step panel. */
export function entryWho(e, roleDefs) {
  if (e.kind === "human") return t("You");
  if (e.kind === "agent" || e.kind === "inner") {
    const rd = roleDef(e.role, roleDefs);
    return `${e.role} · ${e.kind === "inner" ? t("fact.nested") : rd ? agentName(rd.agent) : t("proc.agent")}`;
  }
  return t("fact.flows");
}

const conditions = (e) => Object.entries({ ...(e.waitWhere || {}), ...(e.waitWith || {}) }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");

/** "How it works" in the step panel: one plain line for each thing that applies to the entry. */
export function entryFacts(e, roleDefs) {
  const out = [];
  const fact = (k, v, mono) => out.push(mono ? { k: t(k), v, mono: true } : { k: t(k), v });
  if (e.kind === "human") fact("fact.who", t("You"));
  else if (e.kind === "agent" || e.kind === "inner") {
    const rd = roleDef(e.role, roleDefs);
    fact("fact.who", `${e.role} — ${rd ? agentName(rd.agent) : t("proc.agent")}`);
  } else fact("fact.who", t("fact.flows"));
  if (e.kind === "inner") fact("fact.does", t("does.inner", { role: e.role }));
  if (e.kind === "delay") fact("fact.does", t("does.pause", { d: duration(e.waitMs || 0) }));
  if (e.kind === "wait") fact("fact.does", t("does.wait", { what: eventPhrase(e.waitFor || "") }));
  if (e.kind === "action" && e.sh) {
    fact("fact.runs", e.sh, true);
    fact("fact.where", e.cwd || t("fact.procFolder"));
  } else if (e.kind === "action" && e.do === "type") {
    fact("fact.does", e.text ? t("does.type", { role: e.role, text: e.text }) : t("does.typeNothing", { role: e.role }));
  } else if (e.kind === "action" && e.do) {
    fact("fact.does", ["clear", "compact"].includes(e.do) ? t(`do.${e.do}`, { role: e.role }) : t("do.plugin", { name: e.do }));
    if (e.with && Object.keys(e.with).length) fact("fact.args", JSON.stringify(e.with), true);
  }
  if (e.waitFor && e.kind !== "wait") fact(e.kind === "human" ? "fact.closesOn" : "fact.startsOn", eventPhrase(e.waitFor));
  if (e.waitFor && conditions(e)) fact("fact.cond", conditions(e), true);
  if (e.hold) fact("fact.holds", t("fact.holdsV", { hold: e.hold }));
  if (e.timeoutMs) fact("fact.timeout", duration(e.timeoutMs));
  if (e.skills && e.skills.length) fact("fact.skills", e.skills.join(", "));
  if (e.onFail === "retry" && (e.kind === "agent" || e.kind === "action")) fact("fact.tries", tn("badge.tries", e.retries));
  if (e.onFail === "human" && (e.kind === "agent" || e.kind === "action")) fact("fact.ifFails", t("fact.asksYou"));
  return out;
}

export const currentEntry = (r) => r.plan.find((e) => e.id === r.current) || null;

/** Why a run waits for a person, or null. Agrees with RunSummary.needsYou. */
export function situation(r) {
  const cur = currentEntry(r);
  if (r.status === "needs-human") return cur && cur.status === "failed" ? "failed" : "stopped";
  if (r.status === "done" || r.status === "stopped") return null;
  if (cur && cur.kind === "human" && (cur.status === "active" || cur.status === "waiting")) return "human";
  if (r.agentWait && r.agentWait.human) return "agentAsks";
  if (cur && cur.kind === "inner" && r.needsYou && !cur.child) return "nest";
  return null;
}

/** 1st, 2nd, 3rd, 4th, … 11th, 21st (src/engine.ts has the same) */
const ordinalEn = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

export function describeRun(r) {
  const cur = currentEntry(r);
  const what = cur ? entryPhrase(cur) : t("run.starting");
  switch (situation(r)) {
    case "failed": return { tone: "you", tag: t("tag.stopped"), title: t("run.stepFailed", { step: what }), detail: r.reason };
    case "stopped": return { tone: "you", tag: t("tag.stopped"), title: t("run.stoppedForYou"), detail: r.reason };
    case "human": return { tone: "you", tag: t("tag.yourStep"), title: what, detail: r.waitingOn ? t("run.closesBy", { what: eventPhrase(r.waitingOn) }) : null };
    case "agentAsks": return { tone: "you", tag: t("tag.agentAsks"), title: t("run.agentWaitsForYou", { role: cur ? cur.role : "" }), detail: r.agentWait.note };
    case "nest": return { tone: "you", tag: t("tag.nest"), title: t("nest.title", { role: cur.role }), detail: null };
  }
  if (r.status === "done") return { tone: "calm", tag: t("st.done"), title: t("run.finished"), detail: null };
  if (r.status === "stopped") return { tone: "calm", tag: t("st.stopped"), title: t("run.stopped"), detail: null };
  if (r.status === "paused") return { tone: "calm", tag: t("st.paused"), title: what, detail: null };
  if (r.status === "queued" && r.queue) {
    const n = lang === "ru" ? r.queue.position : ordinalEn(r.queue.position);
    return { tone: "wait", tag: t("tag.queued"), title: t("run.queued", { n, open: r.queue.open, max: r.queue.max }), detail: null };
  }
  if (cur && cur.kind === "inner" && cur.child) return { tone: "wait", tag: t("tag.waiting"), title: what, detail: null };
  if (r.agentWait) return { tone: "wait", tag: t("tag.agentWaits"), title: what, detail: t("run.agentWaitNote", { note: r.agentWait.note }) };
  if (r.waitUntil) return { tone: "wait", tag: t("tag.waiting"), title: t("wait.until", { when: moment(r.waitUntil, Date.now()) }), detail: null };
  if (r.heldBy) return { tone: "wait", tag: t("tag.waiting"), title: holdPhrase(r.heldBy), detail: null };
  if (r.waitingOn) return { tone: "wait", tag: t("tag.waiting"), title: t("wait.for", { what: eventPhrase(r.waitingOn) }), detail: null };
  return { tone: "work", tag: t("tag.working"), title: what, detail: null };
}

/**
 * Open runs as the stacks they form on agents: a run whose nested run is in the list sits under
 * it. Each stack: its top run and the runs under it, nearest first.
 */
export function stacks(runs) {
  const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
  return runs.filter((r) => !(r.child && byId[r.child])).map((top) => {
    const under = [];
    for (let p = byId[top.parent]; p && !under.includes(p); p = byId[p.parent]) under.push(p);
    return { top, under };
  });
}

/** "then: <the step after the current one>", for the tab of a run under a nested one. */
export function thenPhrase(r) {
  const i = r.plan.findIndex((e) => e.id === r.current);
  const next = i < 0 ? undefined : r.plan.slice(i + 1).find((e) => !e.detour);
  return next ? t("stack.then", { step: entryPhrase(next) }) : null;
}

/** The vars a nested run has that its parent has not: what goes back up when it ends done. */
export function handedBack(child, parent) {
  return Object.keys(child.vars).filter((k) => child.vars[k] !== parent.vars[k]);
}

export function holdPhrase(h) {
  return h.run ? t("wait.hold", { hold: h.hold, run: h.run }) : t("wait.holdFree", { hold: h.hold });
}

/** Since when a run has waited for a person (ms), for "waiting 25 min". */
export function waitingSince(r) {
  const s = situation(r);
  const cur = currentEntry(r);
  if (s === "agentAsks") return r.agentWait.since;
  if (s === "human") return (cur && cur.startedAt) || r.updated;
  return r.updated;
}

/** The bar on a run card: non-detour entries, and where the run stands among them. */
export function progress(r) {
  const main = r.plan.filter((e) => !e.detour);
  let at = main.findIndex((e) => e.id === r.current);
  // on a detour, or finished: right after the last finished main entry
  if (at < 0) at = main.filter((e) => e.status === "done" || e.status === "skipped").length;
  return { i: Math.min(at + 1, main.length), n: main.length, segs: main.map((_, i) => (i < at ? "done" : i === at ? "cur" : "todo")) };
}

/** One line for the short "What happened" list, or null for events it leaves out. */
export function eventSentence(e, plan) {
  const id = e.entry || (e.data && e.data.entry);
  const entry = plan.find((x) => x.id === id);
  const role = entry && entry.role ? roleName(entry.role) : t("someone");
  const note = e.data && e.data.note;
  switch (e.type) {
    case "entry.delivered": return t("evs.delivered", { role });
    case "flow.step.done": if (entry && entry.kind === "action") return entryPhrase(entry);
      return t(note ? "evs.doneNote" : "evs.done", { role, note });
    case "flow.step.failed": return t(note ? "evs.failedNote" : "evs.failed", { role, note });
    case "run.set": return t("evs.set");
    case "run.start": return t("evs.start");
    case "flow.iteration.done": return t("evs.round", { n: e.data && e.data.iteration });
  }
  if (plan.some((x) => x.waitFor === e.type)) {
    return t("evs.plugin", { what: eventPhrase(e.type), outcome: t(e.outcome === "failed" ? "outcome.failed" : "outcome.done") });
  }
  return null;
}

/** The chips under a process's name. */
export function processFacts(p) {
  const out = [];
  if (p.repeat) out.push(t("proc.repeat"));
  out.push(p.maxRuns > 1 ? tn("proc.maxRuns", p.maxRuns) : t("proc.oneRun"));
  out.push(p.triggers.length
    ? p.triggers.map((x) => (x.cron ? t("proc.cron", { cron: x.cron }) : t("proc.trigger", { what: eventPhrase(x.on) }))).join(" · ")
    : t("proc.manual"));
  if (p.cwd) out.push(t("proc.cwd", { cwd: p.cwd }));
  return out;
}

/** The rounds a run's events (newest first, as the API sends them) say ended, newest first, each
 * with the note of the step that ended it — the run list only knows the current round. */
export function roundsEnded(events) {
  const out = [];
  let note = null;
  for (const e of [...events].reverse()) {
    if (e.type === "flow.step.done") note = (e.data && e.data.note) || null;
    else if (e.type === "flow.iteration.done") out.push({ iteration: e.data.iteration, at: e.ts, note });
  }
  return out.reverse();
}

/** What a run works on — its `title` var (flowd fills it from the PR title; an agent may set it) —
 * or null, and the UI falls back to "process · run N". A conventional-commit title loses its
 * "type(scope):" prefix and [TICKET] tags here; the full one is the tooltip (`r.vars.title`). */
export function runTitle(r) {
  const full = (r.vars && typeof r.vars.title === "string" && r.vars.title.trim()) || null;
  if (!full) return null;
  const plain = full.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").replace(/\[[A-Z][A-Z0-9]*-\d+\]\s*/g, "").trim();
  return plain ? plain[0].toUpperCase() + plain.slice(1) : full;
}
