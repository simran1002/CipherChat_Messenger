/**
 * Upload module — attachment storage behind a driver interface. {@code local}
 * writes to disk and serves via {@code /uploads/**}; {@code s3} writes to
 * object storage and can hand clients a presigned PUT so E2EE ciphertext
 * never transits the app server.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Uploads")
package com.cipherchat.upload;
