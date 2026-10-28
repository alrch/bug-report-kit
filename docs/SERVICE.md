# Автоматический запуск и восстановление

Жизненным циклом Kit управляет общий код `runtime/service.mjs` и
`runtime/supervisor.mjs`. Проект задаёт экземпляр, пути к своим config/SQLite,
команду и локальные health URLs. Он не копирует watchdog или установщик.
Разные проекты не объединяют базы, конфигурацию и доступы.

## Штатный сервер

После обычной подготовки и сборки установите службу, используя Node≥24:

```sh
node scripts/service.mjs install --instance my-project --config /absolute/path/config.local.json --state /absolute/path/private-kit-service
```

`--state` — отдельный новый каталог или уже приватный каталог этого экземпляра.
Config/SQLite не копируются и не пересоздаются. Команда выводит пути к manifest
и файлу службы. Установка и включение службы разделены. Сначала остановите свой
прежний foreground Kit; чужие процессы по порту не убиваются.

macOS, запуск после входа пользователя:

```sh
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.bug-report-kit.my-project.plist"
launchctl print gui/$(id -u)/com.bug-report-kit.my-project
```

Остановка — `launchctl bootout` с тем же service target, возврат — bootstrap.
Уже работающую службу повторно загружать не нужно. Журнал — `--state/service.log`.
До входа, во время сна или выключения Mac внешний доступ не обеспечивается.

Linux, user service systemd:

```sh
systemctl --user daemon-reload
systemctl --user enable --now bug-report-kit-my-project.service
systemctl --user status bug-report-kit-my-project.service
journalctl --user -u bug-report-kit-my-project.service
```

Остановка — `systemctl --user disable --now bug-report-kit-my-project.service`.
User service зависит от пользовательского менеджера. Запуск без login требует
отдельного решения администратора о linger; установщик его не включает.
Для серверного запуска без пользовательской сессии используйте штатный Compose.
Нативный установщик Windows не реализован; постоянный сервер на Windows-хосте
запускают через Compose с Linux-контейнером.

## Падение и зависание

`npm start` и оба Docker targets запускают внешний watchdog. Он проверяет
`/healthz` дочернего Node-процесса раз в30сек после предыдущей проверки, timeout5сек.
Три последовательных отказа завершают runtime; успех обнуляет счётчик. Выход
child или ошибка запуска также дают ненулевой код. Сначала посылается SIGTERM,
после5сек ожидания — SIGKILL. Launchd/systemd или Docker перезапускает runtime;
launchd/systemd убирают также оставшихся членов своей группы. Один Docker
healthcheck только отмечает unhealthy и не заменяет этот watchdog.
Foreground без системного менеджера не переживает закрытие терминала или выход
watchdog: это режим разработки, а не автозапуск.

Пробы читают только статусы GET, тела не журналируются. Лог содержит время, PID,
code/signal и причины health/bind/child failure без секретов и сообщений.
Child получает минимальные системные пути и только явные BUG_KIT_CONFIG/HOST/
SPEECH_* и HF_HUB_OFFLINE. Глобальные токены и NODE_OPTIONS не наследуются.
Команда собственного распознавателя задаётся существующим config проекта.

## Проектный прокси или дополнительный старт

Кроме Kit проекту может требоваться prefix adapter. Для такого entry используйте
приватный manifest вместо копии установщика:

```json
{
  "schema": 1,
  "instance": "my-project",
  "cwd": "/absolute/path/project",
  "command": ["/absolute/path/node", "/absolute/path/project/start-kit-adapter.mjs"],
  "stateDirectory": "/absolute/path/private-kit-service",
  "healthUrls": ["http://127.0.0.1:7337/healthz", "http://127.0.0.1:7338/bugs/widget.css"],
  "environment": {"BUG_KIT_CONFIG": "/absolute/path/config.local.json"}
}
```

Manifest0600, каталог0700. Выполните
`node scripts/service.mjs install /absolute/path/service.json`, затем включите
службу как выше. Команда запускается напрямую без shell. Пробы ограничены
loopback HTTP без credentials/query/hash. Health URLs должны проверять реальный
путь виджета, включая прокси. Adapter обрабатывает SIGTERM своих child;
для его связей child/listener экспортирована общая `supervise()`. Логику
restart/health и генерацию служб не копируют в каждый проект.

## Обновление подключённых проектов

Исходники общего Kit не обновляют работающие экземпляры автоматически. Сначала
выпускается проверенная ревизия, затем проект штатно обновляет pin/image и
manifest, проверяет backup, сохранность config/SQLite и форму через свой origin.
Старую проектную службу отключают при подготовленной замене; два владельца
порта одновременно не запускаются. Установщик не меняет чужие экземпляры и
не выдаёт права на их выкладку. При смене расположения Kit переустановите только
свою службу и перезапустите её штатным менеджером; installation receipt
проверяет прежнее владение. User service Linux и перезагрузка ОС проверяются
отдельно от unit-тестов генератора файлов.

Настройки systemd сверяются с официальными
[service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) и
[execution](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
