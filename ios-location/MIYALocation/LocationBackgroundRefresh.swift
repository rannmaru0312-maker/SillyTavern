import Foundation
import BackgroundTasks

/// Requests best-effort iOS background opportunities to verify device-local
/// seven-day snapshots. iOS decides whether and when to run a task. This is
/// NOT a guaranteed clock schedule and never uploads private data.
enum LocationBackgroundRefresh {
    static let identifier = "jp.miyalocation.visits.archive-refresh"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            // Each refresh request is one-shot. Ask the OS for the next one.
            schedule()
            let work = Task { @MainActor in
                if Task.isCancelled {
                    refresh.setTaskCompleted(success: false)
                    return
                }
                let recorder = LocationRecorder()
                let verified = recorder.refreshWeeklyArchives()
                refresh.setTaskCompleted(success: verified && !Task.isCancelled)
            }
            refresh.expirationHandler = {
                work.cancel()
            }
        }
    }

    static func schedule() {
        // User consent is required for even the best-effort background task.
        guard UserDefaults.standard.bool(forKey: "miya-weekly-local-archive-enabled") else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
            return
        }
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date().addingTimeInterval(6 * 60 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // e.g. already queued, background refresh disabled, or not permitted.
            // Never claim a successful automatic background run from submission.
        }
    }

    static func cancel() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
    }
}