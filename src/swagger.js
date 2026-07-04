import swaggerUi from 'swagger-ui-express';

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Solax Admin API',
    version: '1.0.0',
    description:
      'Super admin, admin, oddiy user, Telegram WebApp login va role boshqaruvi uchun backend API.',
  },
  servers: [
    {
      url: '/',
      description: 'Current server',
    },
  ],
  tags: [
    { name: 'Health', description: 'Servis holati va umumiy snapshot' },
    { name: 'Auth', description: 'Local login va Telegram WebApp auth' },
    { name: 'Admin', description: 'Admin va super admin statistikasi' },
    { name: 'Devices', description: "Qurilmalar ro'yxati va CRUD amallari" },
    { name: 'Reports', description: "Energiya hisobotlari: soatlik/kunlik/haftalik/oylik/oraliq va kun oxiri (EOD) arxiv" },
    { name: 'Users', description: 'Role va foydalanuvchi boshqaruvi' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 1 },
          username: { type: 'string', nullable: true, example: 'superadmin' },
          displayName: { type: 'string', nullable: true, example: 'Super Admin' },
          telegramId: { type: 'string', nullable: true, example: '123456789' },
          telegramUsername: { type: 'string', nullable: true, example: 'solax_admin' },
          telegramPhotoUrl: {
            type: 'string',
            nullable: true,
            example: 'https://t.me/i/userpic/320/example.svg',
          },
          authProvider: { type: 'string', example: 'local' },
          role: { type: 'string', example: 'super_admin' },
          status: { type: 'string', example: 'active' },
          createdBy: { type: 'integer', nullable: true, example: 1 },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          lastTelegramAuthAt: { type: 'string', format: 'date-time', nullable: true },
          permissions: {
            type: 'array',
            items: { $ref: '#/components/schemas/UserPermission' },
            example: ['users.block', 'devices.crud', 'admins.crud'],
          },
        },
      },
      UserPermission: {
        type: 'string',
        enum: ['users.block', 'devices.crud', 'admins.crud'],
        description:
          'users.block: userlarni bloklash/blokdan chiqarish; devices.crud: device yaratish, yangilash, ochirish va sync; admins.crud: admin yaratish, rol/status/delete boshqaruvi',
      },
      AuthResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
          user: {
            $ref: '#/components/schemas/User',
          },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: false },
          message: { type: 'string', example: "Bu amal uchun yetarli huquq yo'q" },
        },
      },
      HealthResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          service: { type: 'string', example: 'solax-backend' },
          telegramEnabled: { type: 'boolean', example: true },
          generatedAt: { type: 'string', format: 'date-time' },
          snapshot: {
            type: 'object',
            properties: {
              users: { type: 'object' },
              devices: { type: 'object' },
              alerts: { type: 'object' },
            },
          },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          pageSize: { type: 'integer', example: 25 },
          total: { type: 'integer', example: 131 },
          totalPages: { type: 'integer', example: 6 },
        },
      },
      Device: {
        type: 'object',
        properties: {
          registrationNo: { type: 'string', example: 'REG-1001' },
          deviceSn: { type: 'string', nullable: true, example: 'SN123456789' },
          userName: { type: 'string', nullable: true, example: 'Abdulaziz R.' },
          plantName: { type: 'string', nullable: true, example: 'Tashkent Plant' },
          deviceModel: { type: 'string', nullable: true, example: 'X3-HYBRID-10K' },
          telegramIds: {
            type: 'array',
            items: { type: 'string' },
            example: ['7530833627', '998901234567'],
          },
          onlineStatus: { type: 'string', enum: ['Online', 'Offline', 'Unknown'], example: 'Online' },
          lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
          lastCheckedAt: { type: 'string', format: 'date-time', nullable: true },
          addedAt: { type: 'string', format: 'date-time' },
          deviceNo: { type: 'integer', nullable: true, example: 42 },
          deviceName: { type: 'string', nullable: true, example: 'Main Inverter' },
          source: { type: 'string', nullable: true, example: 'manual' },
          trackingEnabled: { type: 'boolean', example: true },
          acPower: { type: 'number', nullable: true, example: 12.4 },
          yieldToday: { type: 'number', nullable: true, example: 18.6 },
          yieldMonth: { type: 'number', nullable: true, example: 426.8 },
          yieldYear: { type: 'number', nullable: true, example: 3695.6 },
          yieldTotal: { type: 'number', nullable: true, example: 12560.7 },
          realtimeUpdatedAt: { type: 'string', format: 'date-time', nullable: true },
          statsDate: { type: 'string', nullable: true, example: '2026-04-23' },
          hasTodayStats: { type: 'boolean', nullable: true, example: true },
        },
      },
      DeviceCreateRequest: {
        type: 'object',
        required: ['registrationNo'],
        properties: {
          registrationNo: { type: 'string', example: 'REG-1001' },
          deviceSn: { type: 'string', example: 'SN123456789' },
          userName: { type: 'string', example: 'Abdulaziz R.' },
          plantName: { type: 'string', example: 'Tashkent Plant' },
          deviceModel: { type: 'string', example: 'X3-HYBRID-10K' },
          telegramIds: {
            type: 'array',
            items: { type: 'string' },
            example: ['7530833627'],
          },
          onlineStatus: { type: 'string', enum: ['Online', 'Offline', 'Unknown'], example: 'Unknown' },
          lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
          lastCheckedAt: { type: 'string', format: 'date-time', nullable: true },
          addedAt: { type: 'string', format: 'date-time', nullable: true },
          deviceNo: { type: 'integer', nullable: true, example: 42 },
          deviceName: { type: 'string', example: 'Main Inverter' },
          source: { type: 'string', example: 'manual' },
          trackingEnabled: { type: 'boolean', example: true },
        },
      },
      DeviceUpdateRequest: {
        type: 'object',
        properties: {
          deviceSn: { type: 'string', nullable: true, example: 'SN123456789' },
          userName: { type: 'string', nullable: true, example: 'Abdulaziz R.' },
          plantName: { type: 'string', nullable: true, example: 'Tashkent Plant' },
          deviceModel: { type: 'string', nullable: true, example: 'X3-HYBRID-10K' },
          telegramIds: {
            type: 'array',
            items: { type: 'string' },
            example: ['7530833627'],
          },
          onlineStatus: { type: 'string', enum: ['Online', 'Offline', 'Unknown'], example: 'Offline' },
          lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
          lastCheckedAt: { type: 'string', format: 'date-time', nullable: true },
          deviceNo: { type: 'integer', nullable: true, example: 42 },
          deviceName: { type: 'string', nullable: true, example: 'Main Inverter' },
          source: { type: 'string', nullable: true, example: 'manual' },
          trackingEnabled: { type: 'boolean', example: false },
        },
      },
      DeviceResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          device: { $ref: '#/components/schemas/Device' },
        },
      },
      DeviceListResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          pagination: { $ref: '#/components/schemas/Pagination' },
          devices: {
            type: 'array',
            items: { $ref: '#/components/schemas/Device' },
          },
        },
      },
      DeviceByTelegramResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          telegramId: { type: 'string', example: '7530833627' },
          total: { type: 'integer', example: 2 },
          devices: {
            type: 'array',
            items: { $ref: '#/components/schemas/Device' },
          },
        },
      },
      DeviceTotals: {
        type: 'object',
        properties: {
          totalDevices: { type: 'integer', example: 131 },
          onlineDevices: { type: 'integer', example: 54 },
          offlineDevices: { type: 'integer', example: 67 },
          unknownDevices: { type: 'integer', example: 10 },
          errorDevices: { type: 'integer', example: 10 },
          totalAcPower: { type: 'number', example: 77.4 },
          totalYieldToday: { type: 'number', example: 5227.0 },
          totalYieldMonth: { type: 'number', example: 8658.6 },
          totalYieldYear: { type: 'number', example: 8658.6 },
          totalYieldTotal: { type: 'number', example: 156988.3 },
          totalPlants: { type: 'integer', example: 134 },
          statsDate: { type: 'string', example: '2026-04-23' },
          month: { type: 'string', example: '2026-04' },
          year: { type: 'string', example: '2026' },
          devicesWithTodayStats: { type: 'integer', example: 116 },
          powerUpdatedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      DeviceStatusResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          status: { $ref: '#/components/schemas/DeviceTotals' },
        },
      },
      DeviceVisibility: {
        type: 'object',
        properties: {
          devicesVisibleToAll: {
            type: 'boolean',
            example: true,
            description: "true bo'lsa oddiy userlar ham barcha device'larni ko'ra oladi",
          },
        },
      },
      DeviceVisibilityResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          visibility: { $ref: '#/components/schemas/DeviceVisibility' },
        },
      },
      DeviceDeleteResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          registrationNo: { type: 'string', example: 'REG-1001' },
          deleted: { type: 'boolean', example: true },
        },
      },
      UserStatus: {
        type: 'object',
        properties: {
          totalUsers: { type: 'integer', example: 120 },
          activeUsers: { type: 'integer', example: 118 },
          blockedUsers: { type: 'integer', example: 2 },
          telegramUsers: { type: 'integer', example: 50 },
          localUsers: { type: 'integer', example: 40 },
          hybridUsers: { type: 'integer', example: 30 },
        },
      },
      UserStatusResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          status: { $ref: '#/components/schemas/UserStatus' },
        },
      },
      AdminStatus: {
        type: 'object',
        properties: {
          totalAdmins: { type: 'integer', example: 3 },
          activeAdmins: { type: 'integer', example: 3 },
          blockedAdmins: { type: 'integer', example: 0 },
          superAdmins: { type: 'integer', example: 1 },
          adminOnly: { type: 'integer', example: 3 },
          admins: { type: 'integer', example: 2 },
          totalPrivilegedUsers: { type: 'integer', example: 4 },
        },
      },
      AdminStatusResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          status: { $ref: '#/components/schemas/AdminStatus' },
        },
      },
    },
  },
  paths: {
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: "Servis holatini ko'rish",
        responses: {
          200: {
            description: "Sog'lom javob",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Username va parol bilan login',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', example: 'superadmin' },
                  password: { type: 'string', example: 'ChangeMe123!' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Login muvaffaqiyatli',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuthResponse' },
              },
            },
          },
          401: {
            description: 'Login xato',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/auth/telegram': {
      post: {
        tags: ['Auth'],
        summary: 'Telegram WebApp initData orqali login',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['initData'],
                properties: {
                  initData: {
                    type: 'string',
                    example: 'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A123%7D&auth_date=1710000000&hash=...',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Telegram auth muvaffaqiyatli',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuthResponse' },
              },
            },
          },
          401: {
            description: 'initData xato yoki eskirgan',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Joriy foydalanuvchini olish',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "Foydalanuvchi ma'lumoti",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean', example: true },
                    user: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/devices': {
      get: {
        tags: ['Devices'],
        summary: "Device ro'yxatini olish",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'search',
            schema: { type: 'string' },
            description: "registrationNo, SN, userName, plantName, deviceName va telegramIds bo'yicha qidiruv",
          },
          {
            in: 'query',
            name: 'status',
            schema: { type: 'string', enum: ['Online', 'Offline', 'Unknown'] },
          },
          {
            in: 'query',
            name: 'source',
            schema: { type: 'string' },
          },
          {
            in: 'query',
            name: 'trackingEnabled',
            schema: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['0', '1', 'true', 'false'] }] },
          },
          {
            in: 'query',
            name: 'page',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            in: 'query',
            name: 'pageSize',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        ],
        responses: {
          200: {
            description: "Device ro'yxati",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceListResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'Faqat admin va super_admin uchun',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
      post: {
        tags: ['Devices'],
        summary: 'Yangi device yaratish (devices.crud)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeviceCreateRequest' },
            },
          },
        },
        responses: {
          201: {
            description: 'Device yaratildi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceResponse' },
              },
            },
          },
          400: {
            description: "So'rov noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'Faqat admin va super_admin uchun',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          409: {
            description: 'registrationNo allaqachon mavjud',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/devices/status': {
      get: {
        tags: ['Devices'],
        summary: "Device status bo'yicha umumiy statistika",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Jami, online, offline va unknown sonlari',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceStatusResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'Faqat admin va super_admin uchun',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/devices/visibility': {
      get: {
        tags: ['Devices'],
        summary: "Device'larni hamma userga ko'rsatish sozlamasi",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Joriy visibility setting',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceVisibilityResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'Faqat admin va super_admin uchun',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
      patch: {
        tags: ['Devices'],
        summary: "Device'larni hamma userga ko'rsatishni yoqish/o'chirish (devices.crud)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  devicesVisibleToAll: { type: 'boolean', example: true },
                  visibleToAll: { type: 'boolean', example: true },
                  enabled: { type: 'boolean', example: true },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Visibility setting yangilandi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceVisibilityResponse' },
              },
            },
          },
          400: {
            description: "So'rov noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'Faqat admin va super_admin uchun',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/reports/energy': {
      get: {
        tags: ['Reports'],
        summary: 'Energiya hisoboti (soatlik/kunlik/haftalik/oylik yoki sana oralig\'i)',
        description:
          "Berilgan oraliqdagi ishlab chiqarilgan energiya seriyasi, umumiy xulosa va qurilmalar kesimi. granularity berilmasa oraliq uzunligiga qarab avtomatik tanlanadi (1 kun → hourly, ≤45 kun → daily, ≤240 kun → weekly, undan katta → monthly). Oddiy foydalanuvchi faqat o'z qurilmalari bo'yicha hisobot oladi.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'startDate',
            required: false,
            schema: { type: 'string', example: '2026-06-28' },
            description: "Boshlanish sanasi (YYYY-MM-DD). Berilmasa endDate - 6 kun",
          },
          {
            in: 'query',
            name: 'endDate',
            required: false,
            schema: { type: 'string', example: '2026-07-04' },
            description: 'Tugash sanasi (YYYY-MM-DD). Berilmasa bugun',
          },
          {
            in: 'query',
            name: 'granularity',
            required: false,
            schema: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly'] },
            description: "Agregatsiya darajasi. hourly faqat bitta kun uchun",
          },
          {
            in: 'query',
            name: 'registrationNo',
            required: false,
            schema: { type: 'string' },
            description: 'Bitta qurilma bo\'yicha hisobot uchun',
          },
        ],
        responses: {
          200: {
            description: 'Hisobot: summary (jami, o\'rtacha, eng yaxshi nuqta), series (grafik uchun) va devices (qurilmalar kesimi, ulush % bilan)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean', example: true },
                    report: {
                      type: 'object',
                      properties: {
                        startDate: { type: 'string', example: '2026-06-28' },
                        endDate: { type: 'string', example: '2026-07-04' },
                        granularity: { type: 'string', example: 'daily' },
                        scope: { type: 'string', example: 'user' },
                        unit: { type: 'string', example: 'kWh' },
                        summary: { type: 'object' },
                        series: { type: 'array', items: { type: 'object' } },
                        devices: { type: 'array', items: { type: 'object' } },
                      },
                    },
                  },
                },
              },
            },
          },
          400: {
            description: "Sana yoki granularity noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: "Bu qurilma hisobotini ko'rish huquqi yo'q",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/reports/daily': {
      get: {
        tags: ['Reports'],
        summary: 'Kun oxiri (EOD) hisobotlar arxivi (admin)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'limit',
            required: false,
            schema: { type: 'integer', example: 30 },
            description: 'Nechta oxirgi hisobot qaytarilsin (max 366)',
          },
        ],
        responses: {
          200: {
            description: 'Scheduler holati va saqlangan kunlik hisobotlar ro\'yxati',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
    '/api/reports/daily/{date}': {
      get: {
        tags: ['Reports'],
        summary: 'Bitta kunning EOD hisoboti (admin, kerak bo\'lsa yaratib beradi)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'date',
            required: true,
            schema: { type: 'string', example: '2026-07-03' },
          },
        ],
        responses: {
          200: {
            description: 'Kun bo\'yicha to\'liq hisobot (perDevice kesimi bilan)',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          404: {
            description: 'Hisobot topilmadi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/reports/daily/generate': {
      post: {
        tags: ['Reports'],
        summary: 'EOD hisobotni qo\'lda yaratish/yangilash (admin)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  date: { type: 'string', example: '2026-07-03', description: 'Berilmasa bugun' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Hisobot yaratildi/yangilandi',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
    '/api/devices/mine': {
      get: {
        tags: ['Devices'],
        summary: "Joriy foydalanuvchining qurilmalarini olish (claim + telegram bog'lanish)",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description:
              "Foydalanuvchi hisobiga ulangan qurilmalar. Har bir device claimedByMe flag bilan qaytadi. devicesVisibleToAll yoqilgan bo'lsa barcha qurilmalar qaytadi",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceByTelegramResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/devices/claim': {
      post: {
        tags: ['Devices'],
        summary: "Seriya raqami (SN) orqali qurilmani o'z hisobiga ulash",
        description:
          "SN devices jadvalidan registrationNo yoki deviceSn bo'yicha qidiriladi. Topilmasa SolaX Cloud API orqali tekshiriladi va muvaffaqiyatli bo'lsa qurilma avtomatik yaratiladi (source='user-claim'). Claim qilingach foydalanuvchining telegramId si qurilmaga ham bog'lanadi.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['serialNumber'],
                properties: {
                  serialNumber: {
                    type: 'string',
                    example: 'SW9XXXXXXX',
                    description: 'Qurilma seriya raqami (registrationNo yoki deviceSn)',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Qurilma hisobga ulandi (created=true bo\'lsa yangi yaratildi)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceResponse' },
              },
            },
          },
          400: {
            description: 'serialNumber yuborilmadi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          404: {
            description: "SN bo'yicha qurilma topilmadi (SolaX Cloud ham tanimadi)",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          409: {
            description: 'Qurilma allaqachon shu hisobga ulangan',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          503: {
            description: "SolaX API vaqtincha tekshira olmadi (token yo'q yoki kvota tugagan)",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/devices/claim/{registrationNo}': {
      delete: {
        tags: ['Devices'],
        summary: "Qurilmani o'z hisobidan uzish (unclaim)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'registrationNo',
            required: true,
            schema: { type: 'string', example: 'SW9XXXXXXX' },
            description: 'Uziladigan qurilmaning registrationNo si',
          },
        ],
        responses: {
          200: {
            description: 'Qurilma hisobdan uzildi',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean', example: true },
                    registrationNo: { type: 'string', example: 'SW9XXXXXXX' },
                    unclaimed: { type: 'boolean', example: true },
                  },
                },
              },
            },
          },
          404: {
            description: 'Bu qurilma hisobga ulanmagan',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/devices/telegram/{telegramId}': {
      get: {
        tags: ['Devices'],
        summary: 'Telegram ID ga biriktirilgan qurilmalarni olish',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'telegramId',
            required: true,
            schema: { type: 'string', example: '7530833627' },
            description: 'Qurilmaga biriktirilgan Telegram hisob ID si',
          },
        ],
        responses: {
          200: {
            description: 'Berilgan Telegram ID ga bog\'langan qurilmalar ro\'yxati',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceByTelegramResponse' },
              },
            },
          },
          400: {
            description: 'telegramId noto\'g\'ri yoki bo\'sh',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: "Oddiy user faqat o'z telegramId bo'yicha ko'ra oladi, adminlar istalgan IDni ko'ra oladi",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/devices/telegam/{telegramId}': {
      get: {
        tags: ['Devices'],
        summary: 'Telegram ID ga biriktirilgan qurilmalarni olish (alias)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'telegramId',
            required: true,
            schema: { type: 'string', example: '7530833627' },
            description: 'Qurilmaga biriktirilgan Telegram hisob ID si',
          },
        ],
        responses: {
          200: {
            description: 'Berilgan Telegram ID ga bog\'langan qurilmalar ro\'yxati',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceByTelegramResponse' },
              },
            },
          },
          400: {
            description: 'telegramId noto\'g\'ri yoki bo\'sh',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: "Oddiy user faqat o'z telegramId bo'yicha ko'ra oladi, adminlar istalgan IDni ko'ra oladi",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/devices/{registrationNo}': {
      get: {
        tags: ['Devices'],
        summary: 'Bitta deviceni olish',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'registrationNo',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: "Device ma'lumoti",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'Faqat admin va super_admin uchun',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          404: {
            description: 'Device topilmadi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
      patch: {
        tags: ['Devices'],
        summary: "Device ma'lumotini yangilash (devices.crud)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'registrationNo',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeviceUpdateRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Device yangilandi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceResponse' },
              },
            },
          },
          400: {
            description: "So'rov noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'Faqat admin va super_admin uchun',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          404: {
            description: 'Device topilmadi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
      delete: {
        tags: ['Devices'],
        summary: "Device va unga bog'liq statistikani o'chirish (devices.crud)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'registrationNo',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: "Device o'chirildi",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceDeleteResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'Faqat admin va super_admin uchun',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          404: {
            description: 'Device topilmadi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/admin/status': {
      get: {
        tags: ['Admin'],
        summary: 'Adminlar bo`yicha umumiy statistika (admins.crud)',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Admin va super adminlar soni va holati',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AdminStatusResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'admins.crud permission kerak',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/users/status': {
      get: {
        tags: ['Users'],
        summary: 'Oddiy userlar bo`yicha umumiy statistika (users.block yoki admins.crud)',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Userlar soni, bloklanganlar va providerlar kesimi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UserStatusResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'users.block yoki admins.crud permission kerak',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/users': {
      get: {
        tags: ['Users'],
        summary: "Foydalanuvchilar ro'yxati",
        description:
          'role=user uchun users.block yoki admins.crud kerak. role=admin uchun admins.crud kerak. role=super_admin faqat super_admin uchun.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'role',
            schema: { type: 'string', enum: ['super_admin', 'admin', 'user'] },
          },
          {
            in: 'query',
            name: 'search',
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: "Userlar ro'yxati",
          },
        },
      },
      post: {
        tags: ['Users'],
        summary: 'Oddiy user yaratish (admins.crud)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', example: 'operator_01' },
                  password: { type: 'string', example: 'secret123' },
                  displayName: { type: 'string', example: 'Operator 01' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Oddiy user yaratildi',
          },
        },
      },
    },
    '/api/users/admins': {
      post: {
        tags: ['Users'],
        summary: 'Yangi admin yaratish (admins.crud)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', example: 'newadmin' },
                  password: { type: 'string', example: 'secret123' },
                  displayName: { type: 'string', example: 'New Admin' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Admin yaratildi',
          },
        },
      },
    },
    '/api/users/{id}/role': {
      patch: {
        tags: ['Users'],
        summary: 'User rolini yangilash (admins.crud)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['role'],
                properties: {
                  role: {
                    type: 'string',
                    enum: ['super_admin', 'admin', 'user'],
                    example: 'admin',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Role yangilandi',
          },
        },
      },
    },
    '/api/users/{id}/status': {
      patch: {
        tags: ['Users'],
        summary: 'User statusini yangilash (users.block yoki admins.crud)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: {
                    type: 'string',
                    enum: ['active', 'disabled'],
                    example: 'disabled',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Status yangilandi',
          },
        },
      },
    },
    '/api/users/{id}/permissions': {
      patch: {
        tags: ['Users'],
        summary: 'Admin permissionlarini yangilash (faqat super_admin)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'integer' },
            description: 'Permission beriladigan admin ID si',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['permissions'],
                properties: {
                  permissions: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/UserPermission' },
                    example: ['users.block', 'devices.crud'],
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Permissionlar yangilandi',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean', example: true },
                    user: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          400: {
            description: "Permission noto'g'ri yoki target user admin emas",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: 'Faqat super_admin uchun',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          404: {
            description: 'Foydalanuvchi topilmadi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/users/{id}': {
      delete: {
        tags: ['Users'],
        summary: "Userni o'chirish (admins.crud)",
        description:
          "admins.crud permissioni bor admin oddiy user/adminlarni o'chira oladi. Super admin va o'zingizni o'chirib bo'lmaydi.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'integer' },
            description: "O'chiriladigan user ID si",
          },
        ],
        responses: {
          200: {
            description: "User o'chirildi",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean', example: true },
                    deletedUserId: { type: 'integer', example: 12 },
                    unlinkedDevices: { type: 'integer', example: 2 },
                    deletedUser: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          400: {
            description: "So'rov noto'g'ri yoki himoyalangan user",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          401: {
            description: "Token noto'g'ri",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          403: {
            description: "Bu amal uchun yetarli huquq yo'q",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          404: {
            description: 'Foydalanuvchi topilmadi',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
  },
};

export const swaggerUiHandler = swaggerUi.serveFiles(null, {
  swaggerUrl: '/openapi.json',
});
export const swaggerUiSetup = swaggerUi.setup(null, {
  explorer: true,
  swaggerUrl: '/openapi.json',
  customSiteTitle: 'Solax Swagger',
});
