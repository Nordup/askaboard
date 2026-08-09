import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Which of the three pickers the attach menu asked for.
///
/// A separate type from `AttachMenuChoice`, one-to-one with it. That enum is what the
/// design-system menu *draws* — three rows, three labels, three glyphs — and this is what
/// the app *mounts*. Keeping them apart means the menu can gain a row the pickers do not
/// answer, or an app surface can open a picker with no menu in front of it, without either
/// side inheriting the other's reason for existing.
enum AttachmentSource: Identifiable, Sendable {
    case photoLibrary
    case camera
    case files

    var id: Self { self }

    init(_ choice: AttachMenuChoice) {
        switch choice {
        case .photoLibrary: self = .photoLibrary
        case .camera: self = .camera
        case .files: self = .files
        }
    }
}

/// The three iOS pickers, mounted once by whichever surface owns the composer.
///
/// One modifier rather than three, because the panel and the full-screen column both need
/// all three and neither should be assembling sheets. Everything it hands back is bytes, a
/// filename and a content type — the app makes no judgement about what a file *is*, which
/// is the server's job (see `server/app/attachments/convert.py`), and it makes no
/// conversion either.
extension View {
    func attachmentPickers(
        source: Binding<AttachmentSource?>,
        onPicked: @escaping (Data, String, String) -> Void
    ) -> some View {
        modifier(AttachmentPickers(source: source, onPicked: onPicked))
    }
}

private struct AttachmentPickers: ViewModifier {
    @Binding var source: AttachmentSource?
    let onPicked: (Data, String, String) -> Void

    @State private var photoItem: PhotosPickerItem?

    func body(content: Content) -> some View {
        content
            .photosPicker(
                isPresented: presenting(.photoLibrary),
                selection: $photoItem,
                matching: .any(of: [.images, .livePhotos])
            )
            .onChange(of: photoItem) { _, picked in
                guard let picked else { return }
                Task { await deliver(picked) }
            }
            .fullScreenCover(isPresented: presenting(.camera)) {
                CameraPicker(
                    onCaptured: { data in
                        onPicked(data, "photo.jpg", "image/jpeg")
                        source = nil
                    },
                    onCancel: { source = nil }
                )
                .ignoresSafeArea()
            }
            .fileImporter(
                isPresented: presenting(.files),
                allowedContentTypes: [.item],
                allowsMultipleSelection: false
            ) { result in
                guard case let .success(urls) = result, let url = urls.first else { return }
                // Security-scoped: a file picked out of another app's container is
                // unreadable without this, and the failure is silent — an empty `Data`
                // and no error at all.
                guard url.startAccessingSecurityScopedResource() else { return }
                defer { url.stopAccessingSecurityScopedResource() }
                guard let data = try? Data(contentsOf: url) else { return }
                let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                onPicked(data, url.lastPathComponent, type ?? "application/octet-stream")
            }
    }

    /// One `AttachmentSource` as the `Bool` binding every system picker wants. Writing
    /// `false` clears the source rather than setting a second flag, so the picker's own
    /// dismissal is what closes it and there is one piece of state, not four.
    private func presenting(_ wanted: AttachmentSource) -> Binding<Bool> {
        Binding(
            get: { source == wanted },
            set: { if !$0 { source = nil } }
        )
    }

    /// A photo, as the bytes the library already holds.
    ///
    /// **`Data` self-representation, not a `UIImage` round trip.** The original bytes are
    /// what the server wants, HEIC included; re-encoding here would be the device
    /// converting, which is the one thing this design says it never does.
    ///
    /// The name is built here because the picker does not carry one: `itemIdentifier` is a
    /// PhotoKit local id — `B84E…/L0/001`, slashes and all — which is neither a name a
    /// learner recognises on a chip nor one that survives a `Content-Disposition` header.
    /// The extension and the content type both come from the item's *own* type, so a PNG
    /// stays a PNG and a HEIC stays a HEIC rather than every photo being labelled as one
    /// of them.
    private func deliver(_ picked: PhotosPickerItem) async {
        defer { photoItem = nil }
        guard let data = try? await picked.loadTransferable(type: Data.self) else { return }
        let type = picked.supportedContentTypes.first
        let name = "photo." + (type?.preferredFilenameExtension ?? "jpg")
        onPicked(data, name, type?.preferredMIMEType ?? "application/octet-stream")
    }
}

/// `UIImagePickerController`, because SwiftUI has no camera.
private struct CameraPicker: UIViewControllerRepresentable {
    let onCaptured: (Data) -> Void
    /// The cover is presented by a binding this view cannot clear on its own, so a tapped
    /// Cancel has to be reported or the learner is left holding a camera with no way out.
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        // Assigning `.camera` on a device that has none — every simulator — throws before
        // the controller is ever presented. The default source type is the photo library,
        // which is a picker the learner can at least dismiss.
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            controller.sourceType = .camera
        }
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCaptured: onCaptured, onCancel: onCancel)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCaptured: (Data) -> Void
        let onCancel: () -> Void

        init(onCaptured: @escaping (Data) -> Void, onCancel: @escaping () -> Void) {
            self.onCaptured = onCaptured
            self.onCancel = onCancel
        }

        /// JPEG, and this is the one place the device does encode: a capture has no
        /// original file to send. 0.9 rather than 1.0 because a lossless JPEG of a
        /// worksheet is several times the size for no legibility a tutor can use.
        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage,
                  let data = image.jpegData(compressionQuality: 0.9) else {
                onCancel()
                return
            }
            onCaptured(data)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}
