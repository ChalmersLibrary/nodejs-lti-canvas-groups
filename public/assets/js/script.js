function downloadCsv(categoryId, categoryName) {
    window.location.href = "/csv/category/" + categoryId + "/" + categoryName.replace("/", "-").replace(" ", "%20");
}

function downloadCsvZoom(categoryId, categoryName) {
    window.location.href = "/csv/zoom/category/" + categoryId + "/" + categoryName.replace("/", "-").replace(" ", "%20");
}

function renderDashboard() {
    if (document.getElementById('chartContainer')) {
        let data_labels = [];
        var data_reads = [];
        var data_reads_total = 0;
        var data_writes = [];
        var data_writes_total = 0;
        
        fetch('/json/stats').then(response => response.json())
        .then(data => {
            data.cache_stats.forEach(value => {
                data_labels.push(value.name);
                data_reads.push(value.reads);
                data_writes.push(value.writes);
                data_reads_total = data_reads_total + value.reads;
                data_writes_total = data_writes_total + value.writes;
            });

            document.getElementById('active_users').innerText = data.active_users_today;
            document.getElementById('total_users').innerText = data.authorized_users;
            document.getElementById('self_signup_configs').innerText = data.self_signup_configs;
            document.getElementById('total_reads').innerText = data_reads_total;
            document.getElementById('total_writes').innerText = data_writes_total;

            (data_reads_total > 0 && data_writes_total > 0) ? document.querySelector('span.percent').innerText = ' (' + Math.round((data_reads_total / data_writes_total) * 100) + '%)': document.querySelector('span.percent').innerText = ' (0%)';

            var ctx = document.getElementById('chartContainer').getContext('2d');

            var myChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: data_labels,
                    datasets: [{
                            label: 'Cache writes',
                            data: data_writes,
                            backgroundColor: 'rgba(32, 161, 112, 1)',
                            borderWidth: 0
                        },
                        {
                            label: 'Cache reads',
                            data: data_reads,
                            backgroundColor: 'rgba(144, 144, 88, 1)',
                            borderWidth: 0
                        }
                    ]
                },
                options: {
                    scales: {
                        yAxes: [{
                            ticks: {
                                beginAtZero: true
                            }
                        }]
                    }
                }
            });
        });
    }
}

document.addEventListener('DOMContentLoaded', function () {
    if (document.location.pathname.startsWith("/loading")) {
        setInterval(function () {
            var progress = document.getElementsByTagName('progress')[0];
            if (progress.value < progress.max) {
                progress.value > 1 && progress.value < 60 ? progress.value += 4 : progress.value += 1;
            }
            if (progress.value >= progress.max) {
                document.querySelector("div.row.error-message").classList.remove("d-none");
            }
        }, 900);
    }
    else if (document.location.pathname.startsWith("/groups")) {
        const btnCsv = document.getElementsByClassName("btn-download-csv");
        const btnCsvZoom = document.getElementsByClassName("btn-download-csv-zoom");
        Array.from(btnCsv).forEach(element => {
            element.addEventListener("click", function () {
                downloadCsv(element.getAttribute("data-category-id"), element.getAttribute("data-category-name"));
            }); 
        });
        Array.from(btnCsvZoom).forEach(element => {
            element.addEventListener("click", function () {
                downloadCsvZoom(element.getAttribute("data-category-id"), element.getAttribute("data-category-name"));
            });
        });

        const selfSignupConfigModal = document.getElementById('selfSignupConfigurationModal');
        selfSignupConfigModal && selfSignupConfigModal.addEventListener("show.bs.modal", event => {
            console.log(event);
            selfSignupConfigModal.querySelector("#css_group_category_name").innerText = event.relatedTarget.dataset.categoryName;
            fetch(`/api/config/self-signup/${event.relatedTarget.dataset.categoryId}/${event.relatedTarget.dataset.categoryName}`)
                .then(response => response.json())
                .then(data => {
                    console.log(data); // TODO: debug
                    selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";

                    selfSignupConfigModal.querySelector("#css_assignment_id").replaceChildren();
                    if (data.assignments && data.assignments.length) {
                        data.assignments.forEach(assignment => {
                            let o = selfSignupConfigModal.querySelector("#css_assignment_id").appendChild(document.createElement("option"));
                            o.value = assignment.id;
                            o.innerText = `${assignment.name} (${assignment.points_possible} points)`;
                            data.current && data.current.assignment_id && o.value == data.current.assignment_id && o.setAttribute("selected", true);
                        })
                    }
                    if (data.assignments && !data.assignments.length) {
                        let o = selfSignupConfigModal.querySelector("#css_assignment_id").appendChild(document.createElement("option"));
                        o.innerText = "No valid assignments found in course";
                        data.current && data.current.assignment_id && o.value == data.current.assignment_id && o.setAttribute("selected", true);
                        selfSignupConfigModal.querySelector("#modalSubmitButton").setAttribute("disabled", true);
                    }
                    if (data.current && data.current.description) {
                        selfSignupConfigModal.querySelector("#css_description").value = data.current.description;
                    }
                    else {
                        selfSignupConfigModal.querySelector("#css_description").value = "";
                    }
                    if (data.current && data.current.min_points) {
                        selfSignupConfigModal.querySelector("#css_min_points").value = data.current.min_points;
                    }
                    else {
                        selfSignupConfigModal.querySelector("#css_min_points").value = "1";
                    }
                    if (data.current && selfSignupConfigModal.querySelector("#modalClearRuleButton").style.display == "none") {
                        selfSignupConfigModal.querySelector("#modalClearRuleButton").style.display = "inline";
                        selfSignupConfigModal.querySelector("#modalSubmitButtonText").innerText = "Save changes";
                    }
                    else {
                        selfSignupConfigModal.querySelector("#modalSubmitButtonText").innerText = "Create new rule";
                    }
                    selfSignupConfigModal.querySelector("#selfSignupConfigurationForm").setAttribute("action", `/api/config/self-signup/${event.relatedTarget.dataset.categoryId}`);
                    selfSignupConfigModal.querySelector("#selfSignupConfigurationForm").addEventListener("submit", event => {
                        const submitButton = selfSignupConfigModal.querySelector("#modalSubmitButton");
                        const submitButtonSpinner = selfSignupConfigModal.querySelector("#modalSubmitButtonSpinner");
                        submitButton.disabled = true;
                        submitButtonSpinner.style.display = "inline-block";

                        selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                        selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";

                        const requestOptions = {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                assignment_id: selfSignupConfigModal.querySelector("#css_assignment_id").value,
                                description: selfSignupConfigModal.querySelector("#css_description").value,
                                min_points: selfSignupConfigModal.querySelector("#css_min_points").value
                            })
                        };
                        console.log(requestOptions); // TODO: debug
                        fetch(selfSignupConfigModal.querySelector("#selfSignupConfigurationForm").getAttribute('action'), requestOptions)
                            .then(response => response.json())
                            .then(data => {
                                console.log(data); // TODO: debug
                                submitButton.disabled = false;
                                submitButtonSpinner.style.display = "none";
                                if (!data.success) {
                                    selfSignupConfigModal.querySelector("#errorInformation").innerText = data.message;
                                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "block";
                                    selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                                }
                                else {
                                    selfSignupConfigModal.querySelector("#successInformation").innerText = data.message;
                                    selfSignupConfigModal.querySelector("#successInformation").style.display = "block";
                                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";
                                    selfSignupConfigModal.querySelector("#modalClearRuleButton").style.display = "inline";
                                    selfSignupConfigModal.querySelector("#modalSubmitButtonText").innerText = "Save changes";
                                }
                            });
                        
                        event.preventDefault();
                        event.stopPropagation();
                    });
                    selfSignupConfigModal.querySelector("#selfSignupConfigurationForm button#modalClearRuleButton").addEventListener("click", event => {
                        const button = selfSignupConfigModal.querySelector("#modalClearRuleButton");
                        const buttonSpinner = selfSignupConfigModal.querySelector("#modalClearRuleButtonSpinner");
                        button.disabled = true;
                        buttonSpinner.style.display = "inline-block";

                        selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                        selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";

                        const requestOptions = {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' }
                        };

                        console.log(requestOptions); // TODO: debug

                        fetch(selfSignupConfigModal.querySelector("#selfSignupConfigurationForm").getAttribute('action'), requestOptions)
                            .then(response => response.json())
                            .then(data => {
                                console.log(data); // TODO: debug

                                button.disabled = false;
                                buttonSpinner.style.display = "none";

                                if (!data.success) {
                                    selfSignupConfigModal.querySelector("#errorInformation").innerText = data.message;
                                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "block";
                                    selfSignupConfigModal.querySelector("#successInformation").style.display = "none";
                                }
                                else {
                                    selfSignupConfigModal.querySelector("#successInformation").innerText = data.message;
                                    selfSignupConfigModal.querySelector("#successInformation").style.display = "block";
                                    selfSignupConfigModal.querySelector("#errorInformation").style.display = "none";
                                    selfSignupConfigModal.querySelector("#modalClearRuleButton").style.display = "none";
                                    selfSignupConfigModal.querySelector("#modalSubmitButtonText").innerText = "Create rule";
                                    selfSignupConfigModal.querySelector("#css_description").value = selfSignupConfigModal.querySelector("#css_description").getAttribute("data-default");
                                    selfSignupConfigModal.querySelector("#css_min_points").value = selfSignupConfigModal.querySelector("#css_min_points").getAttribute("data-default");
                                }
                            });
                        
                        event.preventDefault();
                        event.stopPropagation();
                    });
                });
        });
    }
    else if (document.location.pathname.startsWith("/dashboard")) {
        renderDashboard();
        setInterval(renderDashboard, 600000); // Every 10 mins
    }
});