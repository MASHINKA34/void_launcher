module.exports = {
  SERVER_IP:   'play.z1ppzy.com',
  SERVER_PORT: 25565,

  MC_VERSION:       '1.21.1',
  NEOFORGE_VERSION: '21.1.233',

  LAUNCHER_NAME:    'VoID Cube',
  LAUNCHER_VERSION: '1.2.8',
  GAME_DIR_NAME:    'mylauncher-minecraft',

  // GitHub репозиторий для автообновлений лаунчера.
  // Теги релизов должны быть вида: v1.0.1, v1.0.2 и т.д.
  GITHUB_OWNER: 'MASHINKA34',
  GITHUB_REPO:  'void_launcher',

  // ОДНА публичная папка Яндекс.Диска со всеми зависимостями — запасной источник,
  // если GitHub заблокирован (актуально для РФ). Внутри разложить по подпапкам,
  // пути указаны в *_YANDEX_PATH ниже: /java/<zip>, /neoforge/<offline.zip>, /neoforge/<installer.jar>.
  // Пусто = Яндекс не используется. Пример: 'https://disk.yandex.ru/d/XXXXXXXX'
  YANDEX_DISK_URL: 'https://disk.yandex.ru/d/XyPjlhuALVgu5Q',

  JAVA: {
    RELEASE_TAG:  'java',
    ASSET_NAME:   'OpenJDK21U-jre_x64_windows_hotspot_21.0.11_10.zip',
    ADOPTIUM_URL: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jre_x64_windows_hotspot_21.0.11_10.zip',
    SHA256:       'be26677aaa20b39a62edcaab4c8857a8b76673b0f45abc0b6143b142b62717e4',
    SIZE:         49005708,
    YANDEX_PATH:  '/java/OpenJDK21U-jre_x64_windows_hotspot_21.0.11_10.zip'
  },

  NEOFORGE: {
    OFFLINE_SHA256:   'c035091ad352016ea8f883b9138d59fe43e3b8233c882fa149249a15e3b56bba',
    OFFLINE_SIZE:     97280992,
    INSTALLER_SHA256: '311475c8315ed0be6b5f1dbbf5a377b6c0976457c0bd5aa6d19b0fe25fd77148',
    INSTALLER_SIZE:   6964847,
    OFFLINE_YANDEX_PATH:   '/neoforge/neoforge-21.1.233-offline.zip',
    INSTALLER_YANDEX_PATH: '/neoforge/neoforge-21.1.233-installer.jar'
  }
};
