//
//  KeychainService.swift
//  MeetingAssistant
//
//  系统 Keychain 封装：以 service + account 定位条目，提供第三方 API Key 的
//  保存、读取与删除；条目仅在设备首次解锁后可用且不随备份迁移。
//  所属层：服务层（无状态结构体）。
//

import Foundation
import Security

// MARK: - Keychain 服务

/// Keychain 读写封装；所有方法均可能抛出 KeychainError。
struct KeychainService {
  /// Keychain 操作失败的错误（非预期 OSStatus / 数据无法解析为 UTF-8）。
  enum KeychainError: LocalizedError {
    case unexpectedStatus(OSStatus)
    case invalidData

    var errorDescription: String? {
      switch self {
      case .unexpectedStatus(let status):
        "钥匙串操作失败（\(status)）"
      case .invalidData:
        "无法读取保存的密钥"
      }
    }
  }

  /// 纪要 Provider API Key 的 account 标识。
  static let summaryAPIKeyAccount = "summary-provider-api-key"
  /// 转录 Provider（Whisper）API Key 的 account 标识。
  static let transcriptionAPIKeyAccount = "transcription-provider-api-key"

  /// Keychain service 标识；与其它 App 的条目相互隔离。
  private let service = "com.zqian.meetingassistant.models"

  // MARK: - 公有方法

  /// 保存（覆盖式写入）一个密钥条目。
  ///
  /// - Parameters:
  ///   - value: 密钥明文。
  ///   - account: 条目 account（summary/transcription 两种）。
  /// - 副作用：Keychain 写操作——先删除同 service+account 的旧条目再写入新条目；
  ///   可访问性设为 kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly（不随备份迁移）。
  func save(_ value: String, account: String) throws {
    let data = Data(value.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    // SecItemAdd 遇到已存在条目会报错，先显式删除以实现覆盖语义。
    SecItemDelete(query as CFDictionary)

    var attributes = query
    attributes[kSecValueData as String] = data
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainError.unexpectedStatus(status)
    }
  }

  /// 读取密钥条目。
  ///
  /// - Parameter account: 条目 account。
  /// - Returns: 密钥明文；条目不存在时返回 nil（不算错误）。
  /// - 副作用：Keychain 读操作（受设备解锁状态约束）。
  func load(account: String) throws -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess else {
      throw KeychainError.unexpectedStatus(status)
    }
    guard
      let data = result as? Data,
      let value = String(data: data, encoding: .utf8)
    else {
      throw KeychainError.invalidData
    }
    return value
  }

  /// 删除密钥条目；条目本来不存在也视为成功。
  ///
  /// - Parameter account: 条目 account。
  /// - 副作用：Keychain 删除操作。
  func remove(account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError.unexpectedStatus(status)
    }
  }
}
