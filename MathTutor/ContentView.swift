import PencilKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: TutorStore

    var body: some View {
        Group {
            if store.isWorkspace {
                WorkspaceView()
            } else {
                TutorChatView()
            }
        }
        .tint(.indigo)
    }
}

struct TutorChatView: View {
    @EnvironmentObject private var store: TutorStore
    let onBackToWhiteboard: (() -> Void)?
    @State private var input = ""
    @State private var showingSettings = false
    @FocusState private var inputFocused: Bool

    init(onBackToWhiteboard: (() -> Void)? = nil) {
        self.onBackToWhiteboard = onBackToWhiteboard
    }

    private let quickPrompts = [
        "Help me with a homework problem",
        "I want to get better at algebra",
        "Explain fractions visually"
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                LinearGradient(colors: [Color(uiColor: .systemBackground), Color.indigo.opacity(0.08)], startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    header
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 16) {
                                if store.requiresAPIKey {
                                    APIKeySetupCard { showingSettings = true }
                                        .id("api-key-setup")
                                }
                                ForEach(store.session.messages) { message in
                                    ChatMessageRow(message: message)
                                        .id(message.id)
                                }
                                if store.isLoading {
                                    HStack(spacing: 10) {
                                        ProgressView().controlSize(.small)
                                        Text("Thinking about the next useful step…")
                                            .font(.subheadline)
                                            .foregroundStyle(.secondary)
                                    }
                                    .padding(.horizontal, 18)
                                    .accessibilityLabel("Tutor is thinking")
                                }
                                if onBackToWhiteboard == nil, !store.requiresAPIKey, let plan = store.session.plan, store.session.exercise != nil {
                                    SessionPlanCard(plan: plan, onStart: store.startWorking)
                                        .padding(.top, 6)
                                }
                                if let error = store.errorMessage {
                                    ErrorRetryCard(message: error, retry: store.retryLastRequest)
                                }
                                Color.clear.frame(height: 8).id("bottom")
                            }
                            .frame(maxWidth: 760)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 28)
                            .padding(.vertical, 22)
                        }
                        .scrollDismissesKeyboard(.interactively)
                        .onChange(of: store.session.messages.count) { _, _ in
                            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                        .onChange(of: store.session.plan) { _, _ in
                            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                    }

                    if !store.requiresAPIKey, store.session.plan == nil {
                        quickPromptStrip
                    }
                    if !store.requiresAPIKey {
                        composer
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showingSettings) { SettingsView() }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.indigo.gradient)
                    .frame(width: 46, height: 46)
                Image(systemName: "function")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("Math Tutor")
                    .font(.title2.weight(.bold))
                HStack(spacing: 5) {
                    Circle().fill(store.demoMode ? .orange : (store.requiresAPIKey ? .orange : .green)).frame(width: 7, height: 7)
                    Text(statusText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let onBackToWhiteboard {
                Button(action: onBackToWhiteboard) {
                    Label("Back to whiteboard", systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("back-to-whiteboard")
            }
            Button { showingSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.title3.weight(.semibold))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Tutor settings")
        }
        .padding(.horizontal, 28)
        .padding(.top, 20)
        .padding(.bottom, 10)
    }

    private var quickPromptStrip: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Or start with a suggestion")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(quickPrompts, id: \.self) { prompt in
                        Button(prompt) { store.sendQuickPrompt(prompt) }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .disabled(store.isLoading)
                    }
                }
            }
        }
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 28)
        .padding(.bottom, 12)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 12) {
            TextField("Tell me what you want to learn…", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.body)
                .lineLimit(1...4)
                .focused($inputFocused)
                .submitLabel(.send)
                .onSubmit(send)
                .accessibilityLabel("Message your math tutor")
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .gray : .indigo))
            }
            .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isLoading)
            .accessibilityLabel("Send message")
        }
        .padding(8)
        .padding(.leading, 14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.primary.opacity(0.1)))
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 28)
        .padding(.bottom, 18)
    }

    private var statusText: String {
        let effort = "\(store.session.reasoningEffort.statusName) reasoning"
        if store.demoMode { return "Demo tutor · explicit debug mode · \(effort)" }
        if store.requiresAPIKey { return "Setup required · add API key in Settings" }
        return "Live tutor · \(store.session.selectedModel.displayName) · \(effort)"
    }

    private func send() {
        let value = input
        input = ""
        store.send(value)
        inputFocused = true
    }
}

struct APIKeySetupCard: View {
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Connect your tutor", systemImage: "key.fill")
                .font(.headline.weight(.semibold))
                .foregroundStyle(.indigo)
            Text("Add an OpenAI API key in Settings to start tutoring. The key stays in this device’s Keychain.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Open Tutor Settings", action: onOpenSettings)
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("open-api-key-settings")
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.orange.opacity(0.3)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("api-key-setup-card")
    }
}

struct ChatMessageRow: View {
    let message: TutorMessage

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if message.role == .tutor {
                Image(systemName: "sparkles")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.indigo)
                    .frame(width: 28, height: 28)
                    .background(Color.indigo.opacity(0.12), in: Circle())
                TutorStructuredText(message.text)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 17).stroke(Color.primary.opacity(0.08)))
                Spacer(minLength: 35)
            } else {
                Spacer(minLength: 35)
                LearnerLiteralText(message.text)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                    .background(Color.indigo, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.role == .tutor ? "Tutor" : "You"): \(message.text)")
    }
}

struct SessionPlanCard: View {
    let plan: SessionPlan
    let onStart: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("YOUR SESSION PLAN")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.indigo)
                    Text(plan.title)
                        .font(.title3.weight(.bold))
                    Text(plan.goal)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "map.fill")
                    .foregroundStyle(.indigo)
                    .font(.title2)
            }
            VStack(alignment: .leading, spacing: 9) {
                ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .top, spacing: 10) {
                        Text("\(index + 1)")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.indigo)
                            .frame(width: 24, height: 24)
                            .background(Color.indigo.opacity(0.1), in: Circle())
                        Text(step).font(.subheadline)
                    }
                }
            }
            Button(action: onStart) {
                Label("Start working on the board", systemImage: "pencil.and.scribble")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("start-working")
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.indigo.opacity(0.2)))
    }
}

struct ErrorRetryCard: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.subheadline)
            Spacer()
            Button("Retry", action: retry).buttonStyle(.bordered)
        }
        .padding(14)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
    }
}
