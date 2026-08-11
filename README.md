
<p align="center">

<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

---
# Homebridge Samsung Air Purifier (Home Assistant Edition)

Home Assistant에 로컬로 연결된 삼성 공기청정기를 하나의 HomeKit 타일로 노출하는 Homebridge 플러그인입니다.
SmartThings 클라우드를 거치지 않고, Home Assistant의 REST/WebSocket API로 **LAN 안에서만** 동작합니다.

## 왜 이 플러그인인가

Home Assistant의 내장 HomeKit Bridge로 기기를 그대로 내보내면 엔티티 1개당 액세서리 1개가 만들어져서,
전원 스위치·팬·센서가 애플 홈 앱에 따로따로(그룹 타일로) 나타납니다. 이 플러그인은 하나의 `fan` 엔티티와
관련 `sensor` 엔티티들을 읽어 **공기청정기 서비스 하나**(+ linked 공기질 센서)로 묶어서 보여줍니다.

## Install

---

```
npm i -g homebridge-samsung-air-purifier
```

## 동작 방식

- **명령**(켜기/끄기/프리셋 변경)은 Home Assistant REST API로 보냅니다: `POST /api/services/<domain>/<service>`
- **상태 변화**는 Home Assistant WebSocket API(`/api/websocket`)를 구독해서 실시간으로 반영합니다.
  이 플러그인이 사용하는 엔티티만 `subscribe_trigger`로 구독하므로 불필요한 트래픽이 없습니다.
- WebSocket 연결이 끊기면 자동으로 REST 폴링(`updateInterval`)으로 전환되고, 백그라운드에서 주기적으로
  재연결을 시도합니다. 다시 연결되면 폴링은 멈추고 실시간 구독으로 돌아갑니다.
- 기기 목록은 SmartThings처럼 자동으로 탐색하지 않고 **config.json에 엔티티 ID를 직접 지정**합니다.

## Prerequisites

- Home Assistant가 삼성 공기청정기를 이미 로컬로 제어하고 있어야 합니다 (예: `localthings` 커스텀 통합을 통한
  CoAP-DTLS 연결). 이 플러그인은 Home Assistant의 `fan` / `sensor` 엔티티만 사용합니다.
- 사용할 `fan` 엔티티는 `preset_mode`를 지원해야 합니다 (`fan.set_preset_mode` 서비스 호출 가능).
  퍼센트 속도(`fan.set_percentage`)는 사용하지 않습니다.

## Home Assistant 장기 액세스 토큰(Long-Lived Access Token) 발급

1. Home Assistant에 로그인 후 좌측 하단 프로필(사용자 이름)을 클릭합니다.
2. 화면 아래로 스크롤해 **"보안"** 탭 → **"장기 액세스 토큰"** 섹션으로 이동합니다.
3. **"토큰 생성"**을 눌러 이름(예: `homebridge`)을 지정하고 생성된 토큰 문자열을 복사합니다.
   (이 토큰은 다시 볼 수 없으니 안전한 곳에 보관하세요.)
4. 이 토큰을 아래 config의 `haToken`에 넣습니다.

## Configuration

`config.json`의 `platforms` 배열에 아래와 같이 추가합니다. (Homebridge UI의 플러그인 설정 화면에서도
동일한 항목을 입력할 수 있습니다.)

```json
{
  "platform": "HomeAssistantAirPurifier",
  "haUrl": "http://<HA_LAN_IP>:8123",
  "haToken": "<장기 액세스 토큰>",
  "updateInterval": 15,
  "devices": [
    {
      "name": "공기청정기",
      "fanEntity": "fan.samsung_air_purifier_a_vtww_tp2_21_common",
      "autoPreset": "smart",
      "manualPresets": ["sleep", "windfree", "max"],
      "airQualityEntity": "sensor.samsung_air_purifier_a_vtww_tp2_21_common_clean_level",
      "pm25Entity": "sensor.gonggiceongjeonggi_rokeol_pm2_5",
      "pm10Entity": "sensor.gonggiceongjeonggi_rokeol_pm10"
    }
  ]
}
```

### 설정 항목

| 항목 | 위치 | 설명 |
| --- | --- | --- |
| `haUrl` | 플랫폼 | Home Assistant의 LAN 주소 (예: `http://homeassistant.local:8123`) |
| `haToken` | 플랫폼 | 위에서 발급한 장기 액세스 토큰 |
| `updateInterval` | 플랫폼 | WebSocket이 끊겼을 때 REST로 폴링하는 주기(초). 기본 15 |
| `devices[].name` | 기기 | HomeKit에 표시될 이름 |
| `devices[].fanEntity` | 기기 | `preset_mode`를 지원하는 `fan.` 엔티티 ID (필수) |
| `devices[].autoPreset` | 기기 | HomeKit `TargetAirPurifierState.AUTO`에 대응할 `preset_mode`. 기본 `smart` |
| `devices[].manualPresets` | 기기 | 슬라이더(약→강 순서)에 매핑할 나머지 `preset_mode` 목록. 기본 `["sleep","windfree","max"]` |
| `devices[].airQualityEntity` | 기기 | 1(좋음)~4(매우나쁨) 등급을 보고하는 공기질 센서 엔티티 |
| `devices[].pm25Entity` | 기기 | PM2.5 센서 엔티티 (µg/m³) |
| `devices[].pm10Entity` | 기기 | PM10 센서 엔티티 (µg/m³) |
| `devices[].airQualityMapping` | 기기 | 공기질 등급 1~4를 HomeKit `AirQuality`(1 EXCELLENT ~ 5 POOR)로 바꾸는 4개짜리 배열. 기본 `[1, 2, 4, 5]` |

## HomeKit에서 보이는 모습

- **AirPurifier 서비스**: 전원(Active), 현재 상태(CurrentAirPurifierState), 자동/수동
  (TargetAirPurifierState), 풍량 슬라이더(RotationSpeed)
- **AirQualitySensor 서비스**(위 타일에 linked): 공기질 등급, PM2.5, PM10

풍량 슬라이더는 `manualPresets` 개수만큼만 멈추도록 `minStep`을 설정합니다(예: 3개면 약 33% 간격).
`autoPreset`(기본 `smart`)은 슬라이더가 아니라 자동/수동 스위치의 **AUTO**에 대응하며, 자동 모드에서는
슬라이더가 마지막으로 사용한 수동 단계를 계속 보여줍니다.

## HA 내장 HomeKit Bridge와 함께 쓰지 마세요

⚠️ 같은 `fan`/`sensor` 엔티티를 Home Assistant의 **내장 HomeKit Bridge 통합**에도 노출시켜 두면,
애플 홈 앱에 **같은 기기가 두 개의 타일로 중복**되어 나타납니다 (하나는 이 플러그인이 만든 통합 타일,
다른 하나는 HA가 엔티티별로 쪼개서 만든 타일들). 반드시 Home Assistant의 HomeKit Bridge 설정에서
이 공기청정기의 `fan`/`sensor` 엔티티들을 **제외(entity filter에서 제거)**한 뒤 사용하세요.

## 문제 해결

- 시작 로그에 `haUrl`/`haToken` 누락 또는 `fanEntity` 형식 오류가 있으면 명확한 오류 메시지가 출력되고
  해당 기기는 등록되지 않습니다.
- Home Assistant와의 통신이 실패하면(REST 호출 실패 등) HomeKit에는 "응답 없음"으로 전달되며, 로그에
  원인이 함께 기록됩니다.

## Development

```
npm install
npm run build
npm test
npm run lint
```

`npm test`는 실제 `hap-nodejs` 서비스/캐릭터리스틱 위에서 액세서리를 동작시키고, Home Assistant는
가짜(in-memory) 클라이언트로 대체하는 스모크 테스트입니다. 실제 기기나 네트워크 없이 실행됩니다.

## Note

이 릴리스는 SmartThings 클라우드 연동을 제거하고 Home Assistant 로컬 연동으로 전면 교체했습니다.
에어컨(`AirConditioner`) 액세서리는 이번 개편에서 함께 이전되지 않았으며 현재 등록되지 않습니다.
